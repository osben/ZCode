# UI token compliance cleanup

Source of truth: `DESIGN.md` ("Highest-priority UI constraint", "Color Usage Rules").

## Product rules

1. Application UI typography uses only `text-ui-*`. No `text-sm`, `text-xs`, `text-base`, or `text-[Npx]`.
   - Legacy mapping: `text-sm` (14px) -> `text-ui-base`; `text-xs` (12px) -> `text-ui-sm`.
   - `text-[7px]` badge on the composer attachment overlay -> `text-ui-2xs` is NOT allowed (axis furniture only); use `text-ui-xs`.
   - Page-title `text-[30px]` (Automations) and onboarding `text-[16px]` are display headings; use `text-ui-xl` / `text-ui-lg`.
   - Accepted visual change: the Automations page title shrinks from 30px to 18px (`text-ui-xl`); no 30px token exists.
2. Colors come from semantic tokens, never Tailwind palette colors (`sky-500`, `green-500`, ...) or `dark:` palette pairs. Tokens are theme-aware, so `dark:` variants are dropped.
   - green/emerald -> `success`; red -> `destructive`; yellow/amber/orange -> `warning`;
     sky/blue -> `icon-blue`; slate/zinc/gray -> `foreground-subtle` / `tag`.
   - Unread/new indicator dots use `bg-icon-blue`.
   - Plugin component kind badges reuse the mention-node token families (`command-node`, `skill-node`) and `warning` / `tag`.
3. Raw `white/N` / `black/N` fills on controls -> `bg-surface` at rest and `bg-surface-hover` on hover (Zai Dark sets `--color-hover` equal to `--color-surface`, so `bg-hover` alone gives no hover feedback on `bg-surface`).

## Documented exemptions (unchanged)

- Modal backdrop scrims (`bg-black/N` on `fixed inset-0`): no scrim token exists.
- Unused vendored ai-elements kit (`commit`, `package-info`, `schema-display`, `test-results`, `file-tree`, `web-preview`, `speech-input`, `terminal`, `audio-player`): no product importers; migrate when adopted. Used ones (`tool`, `queue`) are migrated.
- Fluid onboarding hero title (`text-[clamp(...)]`) and its `dark:text-slate-200` override on hero-palette text.
- Brand/third-party surfaces: ChatGPT sign-in button, plugin detail prompt over art, Coding Plan discount card on a brand fill, hero art hex colors, mermaid/terminal rendering content, workflow avatar palette.
- `WorkspaceCustomizeDialog` color swatches: user-selectable data palette, not UI chrome.

## Acceptance

- `grep -E '\btext-(sm|xs|base)\b|text-\[[0-9]+px\]'` over non-test `.tsx` in `packages/ui/src` has no hits outside comments.
- No palette-color utilities in product components outside the exemptions above.
- `pnpm typecheck`, `pnpm lint`, and the UI tests pass; light/dark visual parity relies on tokens.
