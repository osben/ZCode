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
  - Each `Context windows` breakdown row shows estimated tokens before its percent (`Messages  257.3K  85.5%`). The runtime breakdown reports characters only, so row tokens are `round(share × usage.contextWindow.usedTokens)`, where share is the row's character proportion; rows therefore add up to the header's used value and cannot be mistaken for it. Row tokens use the same localized compact units as the header summary
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

The context meter must report the runtime's compaction thresholds, not arbitrary fixed percentages;
reaching a threshold does not guarantee that a compaction action will run. The threshold math lives
in one place, `packages/shared/src/contextBudgetPolicy.ts`, including the output-reserve cap and
configurable buffer. The CLI compact policy (`apps/zcode-cli/packages/core/src/compact/policy.ts`)
delegates its existing threshold helpers to shared; `microcompact.ts` and the UI consume the same
shared constants/helpers. Shared constants and calculations are the single source of truth; core
keeps its existing export names as wrappers.

Threshold math (defaults, mirroring the runtime policy):

- `autoCompactThreshold = max(0, contextWindow − min(maxOutputTokens ?? 32K, 21K) − 13K)` — the
  token count at which the next model step triggers a full summary compaction.
- An explicitly configured `bufferTokens: 0` is valid and removes the configurable safety buffer;
  an omitted or invalid buffer uses the 13K default.
- `microcompactThreshold = max(0, min(floor(autoCompactThreshold × 0.9), autoCompactThreshold − 2K))` — the token count at which old tool results start being cleared, matching `buildDefaultMicrocompactThreshold` in the runtime.
- The runtime resolves `autoCompactThreshold` from the selected model, context-budget strategy, model output limit, and effective compact configuration. Main-turn completion events carry it into `usage.contextWindow.autoCompactThresholdTokens` and mark it authoritative. The required field remains `null` when unknown for old-client compatibility; the additive authority flag distinguishes that placeholder from an authoritative `null` (disabled).
- Main-turn completion events also carry `usage.contextWindow.microcompactThresholdTokens`. It is the configured `microcompact.thresholdTokens`, or the default formula above when microcompact is enabled without an override; `null` means microcompact is disabled or unsupported. The UI uses this authoritative threshold when present. If the field is absent in a legacy event, the UI treats microcompact as unknown and does not show a microcompact warning because legacy data cannot establish that the opt-in policy is enabled.
- Legacy events without an authoritative auto-compact threshold still use the default auto-compact estimate. This fallback does not infer microcompact state.
- V4 usage snapshots retain the required auto threshold field for older clients and use an additive authority flag to distinguish legacy/unknown `null` from authoritative disabled `null`. Microcompact remains additive: an absent field is unknown and does not warn, while explicit `null` is disabled/unsupported.
- On model selection, numeric thresholds are invalidated because they belong to the previous model; explicit `null` values are retained so a disabled/unsupported policy is not mistaken for a legacy unknown threshold before the next main-turn completion.

UI tone mapping (`resolveContextBudgetTone`):

- `critical`: `usedTokens ≥ autoCompactThreshold` — the auto-compact threshold has been reached.
- `warning`: `microcompactThresholdTokens` is a number and `usedTokens ≥ microcompactThresholdTokens` — the microcompact threshold has been reached. An absent or null threshold does not produce a microcompact warning. A configured zero threshold is an immediate token-pressure boundary in the runtime.
  These tones report token-budget state only; runtime may still skip either operation based on
  available history, compact candidates, or safety guards.
- `normal`: below the microcompact threshold, or invalid input (`usedTokens ≤ 0`/non-finite).

Rendering rules:

- The round trigger recolors via foreground semantic tokens: `warning` → `text-warning`,
  `critical` → `text-destructive`. A quota-reset opportunity tone on the same trigger keeps
  priority (transient state wins over steady state).
- The context panel gains one label/value row `chat.contextUsage.autoCompact` showing the
  auto-compact point as `≈{compact tokens} ({percent of window})`, styled like the cache-hit-rate
  row. Numeric thresholds are rendered even when the threshold is zero; an explicit `null` (disabled)
  suppresses the row.
- The trigger carries `data-usage-tone={tone}`; the hidden `TID_V4_MODEL_CONFIG` anchor adds the
  same attribute for E2E assertions.
- The trigger's accessible name appends a localized threshold-reached status whenever the context
  budget tone is active. It does not claim compaction is occurring or guaranteed. Quota-reset tones
  retain their visual priority.
- Legacy events without authoritative thresholds use the 21K preflight reserve estimate; current
  main-turn events use the runtime thresholds directly.

Acceptance scenarios:

1. 200K window, no max output, auto-compact enabled, and microcompact explicitly enabled without a threshold override: auto is 166 000 and micro is 149 400; used 149 399 renders normal, 149 400 warning, and 166 000 critical. The panel row shows `≈166K (83%)` in en-US.
2. Microcompact disabled or auto-compact disabled: its corresponding threshold is `null`, and the UI does not warn for that policy.
3. A configured microcompact threshold is displayed as the warning boundary; the UI does not substitute its default. Legacy events with an absent microcompact threshold do not show a microcompact warning. A configured zero threshold is immediate in the runtime.
4. Quota-reset reminder visible with `usedTokens ≥ autoCompactThreshold`: trigger keeps the
   quota tone (success/urgent) and does not apply the budget tone.
5. Invalid usage (`used = 0` or non-finite): no trigger recolor, tone attribute reads `normal`.
6. A high-usage session with explicit `null` thresholds keeps both policies disabled immediately
   after a model switch; only a later authoritative main-turn completion can replace those states.
7. An authoritative auto-compact threshold of zero is an immediate boundary and renders `≈0 (0%)`;
   an explicit `null` disables the row.
