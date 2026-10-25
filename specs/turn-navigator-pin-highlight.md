# Turn navigator pinned highlight

Status: implemented (2026-10-15).

## Problem

The conversation query map (`ConversationTurnNavigator`, aria label `chat.turnNavigator.label`) renders one monochrome bar per realUser query. Message pins (`pinnedAt` on `userInput`/`assistantText` rows, shown in `ConversationPinnedBar`) are invisible in the map: a turn holding pinned content looks like every other turn, so the rail cannot be used to locate pins while scrolling.

## Decisions

1. **Semantics — an entry is pinned when its query or its turn's answer is pinned.** The map entry represents a query, but the useful lookup is "which turn holds my pinned answer": `item.isPinned = queryRow.pinnedAt !== undefined || unit.assistantTextRows.some((row) => row.pinnedAt !== undefined)`. All `assistantText` rows of a unit live in `assistantTextRows` (turn-tail rows are only markers/artifacts), so no row kind is missed. Pin-able kinds are only `userInput` and `assistantText` (`PinnedConversationRow`), matching this check.
2. **Color is the only reliable differentiator.** The proximity system already occupies the opacity/scale space (idle 0.58/1, mid 0.72/1.25, near 0.86/1.7, peak 1/2.6), so a "louder monochrome" pinned bar would be indistinguishable from neighbors of the hovered item. Pinned bars take a dedicated amber token instead.
3. **Color vehicle — semantic token, not raw palette classes.** New token `--color-pinned-turn`, following the `--color-worktree-task` pattern with explicit coverage in all four theme blocks (`@theme`, `.dark`, `.theme-zai-light`, `.theme-zai-dark`); the theme classes are mutually exclusive selectors, so each needs its own value:
   - `@theme` / `.theme-zai-light`: `var(--color-amber-600)`
   - `.dark` / `.theme-zai-dark`: `var(--color-amber-400)`
     Amber is the bookmark/pin metaphor; violet is already taken by two marker meanings (idle-task, worktree-task) on other surfaces.
4. **Pinned wins over focus/muted color, shape system unchanged.** The bar's `bg-pinned-turn` is appended after the colorTone branches in the `cn(...)` chain (tailwind-merge: last background utility wins), so proximity scale/opacity and the running opacity boost keep working and a pinned bar stays findable even while neighbors are hovered. The scroll-active bar keeps its pinned color too.
5. **Tooltip badge.** Pinned entries show a `PinIcon` + `chat.turnNavigator.pinnedLabel` caption above the query preview in the hover card, so the amber color is self-explanatory. New i18n key in all three catalogs (`en-US` "Pinned", `zh-CN` "已固定", `uk-UA` "Закріплено"); no placeholders, so catalog parity is unchanged.
6. **Contract surface.** The button gains `data-pinned="true"|"false"` (same always-rendered pattern as `data-running`). E2E locates items by testid, so the attribute is additive.

## Scope

Render-only: `conversationTurnNavigatorHelpers.ts` (`isPinned` on the built item), `ConversationTurnNavigator.tsx` (bar color, `data-pinned`, tooltip badge), `styles.css` token, three locale catalogs. No protocol, store, or projection changes — `pinnedAt` already reaches render units on both row schemas.

## Validation

- `packages/ui/test/v4ConversationTurnNavigator.test.ts`: builder marks an item pinned from either the query row or the turn's answer; render emits `data-pinned` and `bg-pinned-turn` only for pinned entries.
- i18n catalog parity (`i18nCatalogParity.test.ts`).
- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, oxfmt on touched files.

## Out of scope

- Cross-highlight from `ConversationPinnedBar` chips (hover chip → highlight rail entry) — needs a pinned-rowId → item lookup; separate step if wanted.
- Counting multiple pins per entry, pin ordering in the rail, or restyling the pinned bar itself.
- Radix renders `HoverCardContent` closed in static markup, so the tooltip badge has no static-render test; it is covered by the item flag test and manual QA.
