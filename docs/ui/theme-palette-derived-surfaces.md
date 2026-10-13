# Theme Palette Derived Surfaces

## Problem

Accent palette blocks (`.palette-ocean`, `.palette-forest`, `.palette-ember`, `.palette-violet`,
`.palette-slate`, `.palette-rose`, `.palette-sand`, `.palette-mint`) in
`packages/ui/src/styles.css` override the core surface tokens (`--color-background`,
`--color-sidebar`, `--color-header`, `--color-panel`, `--color-card`, `--color-popover`,
`--color-input`) but previously left the overlay and selection tokens at the neutral base
values:

- `--color-menu`, `--color-menu-hover`
- `--color-popover-header`
- `--color-tooltip`, `--color-tooltip-tag`
- `--color-card-selected`
- `--color-input-focused`

`DropdownMenu` / `Select` / `ContextMenu` content uses `bg-menu`, tooltips use `bg-tooltip`,
and selected cards use `bg-card-selected`. With an accent palette active these surfaces fell
back to the base neutral values — pure white in light mode and near-black `neutral-950` in
dark mode — while the surrounding panels carried the palette tint. The visible symptom is
unthemed (near-black in dark mode) dropdown content such as `dropdown-menu-content`.

## Rule

Token ownership per theme layer:

- Base `.light` / `.dark` and `theme-zai-light` / `theme-zai-dark` blocks keep their existing
  explicit values for every token. They are unchanged by this spec.
- Accent `.palette-*` blocks pin only the core hex set (kept in sync with
  `packages/ui/src/lib/themePalettes.ts` by `packages/ui/test/themeContrast.test.ts`) and MUST
  derive the overlay and selection tokens from their own core tokens, following the zai theme
  semantics (menu matches popover; header and tooltip are recessed; hover and selected states
  are one contrast step away from the surface):

| Token                    | Light derivation                                                          | Dark derivation                                                           |
| ------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `--color-menu`           | `var(--color-popover)`                                                    | `var(--color-popover)`                                                    |
| `--color-menu-hover`     | `color-mix(in oklab, var(--color-popover) 92%, var(--color-neutral-950))` | `color-mix(in oklab, var(--color-popover) 92%, var(--color-white))`       |
| `--color-popover-header` | `color-mix(in oklab, var(--color-popover) 94%, var(--color-neutral-950))` | `color-mix(in oklab, var(--color-popover) 88%, var(--color-neutral-950))` |
| `--color-tooltip`        | `color-mix(in oklab, var(--color-popover) 92%, var(--color-neutral-950))` | `color-mix(in oklab, var(--color-popover) 85%, var(--color-neutral-950))` |
| `--color-tooltip-tag`    | `color-mix(in oklab, var(--color-popover) 88%, var(--color-neutral-950))` | `color-mix(in oklab, var(--color-popover) 94%, var(--color-white))`       |
| `--color-card-selected`  | `color-mix(in oklab, var(--color-popover) 92%, var(--color-neutral-950))` | `color-mix(in oklab, var(--color-popover) 92%, var(--color-white))`       |
| `--color-input-focused`  | `var(--color-input)`                                                      | `var(--color-input)`                                                      |

The derivation expressions reference the palette's own core tokens, so they resolve against the
palette's `--color-popover`/`--color-input` values. Unlike the token-specific derivations inside
a single block, this is not automatic: every palette block repeats all seven declarations, and
completeness is enforced by `packages/ui/test/themeContrast.test.ts`, which pins the exact
expression per token and mode — a palette that omits a derived token fails CI instead of
silently rendering neutral overlays.

`--color-border` and `--color-popover-border` intentionally stay neutral in accent palettes
for now; retinting borders is a separate decision.

## Acceptance Scenarios

1. With each accent palette in light mode, dropdown/select/context-menu content, menu item
   hover, tooltips, popover headers, and selected cards render palette-tinted instead of
   neutral white.
2. With each accent palette in dark mode, the same surfaces render palette-tinted instead of
   near-black `neutral-950`.
3. The `neutral` and `zai` themes are pixel-identical to before the change (no base or zai
   block is modified).
4. `packages/ui/test/themeContrast.test.ts` verifies the derived expressions in every accent
   palette block in both modes.
