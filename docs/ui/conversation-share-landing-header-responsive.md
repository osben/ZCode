# Responsive Header Layout for the Share Landing Page

## Goal

As the browser width changes between narrow and wide layouts, `ZCode`, the share title, and the “Continue in ZCode” button move continuously along the same track. Header height, single-line title truncation, and button availability remain stable through the transition; switching from narrow to wide layout must not cause a jump.

## Layout Contract

The header uses a full-width shell with fixed height. The brand, title, and continue button remain mounted, with their positions controlled by the same set of geometry variables:

```text
Narrow p=0                 Transition p∈(0,1)                  Wide p=1
Inline within content       Brand/button move continuously       Brand/button align with viewport edges
```

Calculate `p` from the measured available width; do not use a single CSS breakpoint. Check safe space independently on each side: when the left gutter can fit `ZCode`, its margin, and safety spacing, keep the brand at its viewport-side anchor; only move the brand back toward the content column along the track when the left gutter is too small. Apply the same independent rule to the right-side CTA. Interpolate the title's left edge between the safe spacing after the brand and the left edge of the body content column. Set its right edge to the lesser of the body content column's right edge and the safe spacing before the button.

Keep the title on one line at all times and use native ellipsis. During window resizing, change only the available title width; do not change Header height or mount/unmount the brand, title, or continue button with `display: none`.

## Protection for Extremely Narrow Windows

Within the narrow widths covered by screenshots, keep the continue button's full label and click target. Enter compact-button mode only when the actual width is below the button's minimum safe width. In compact mode, preserve the accessible name and click target and shrink the label; do not abruptly remove the button from the layout.

## Theme Switching Contract

Keep an icon theme button on the right side of the Header, before “Continue in ZCode.” Show the theme button on read-only shares that have no continue button. The icon is a sun or moon based on the currently resolved theme, and `aria-label` and `title` describe the next action.

- The share entry point first reads `zcode-theme`; when no preference has been saved, default to `zai-light`. Continue resolving `system` from the system preference.
- Clicking the theme button changes the current resolved theme to an explicit `zai-light` or `zai-dark`, and synchronizes the root theme class, browser theme metadata, and persisted `zcode-theme` value.
- The continue button uses only `bg-primary text-primary-foreground`: black with white text in the light theme, and white with black text in the dark theme.
- Measure the theme and continue buttons together as part of the right-side geometry; they must not squeeze the title or be hidden on narrow screens.

## Implementation Constraints

- `ResizeObserver` updates continuous geometry values or CSS custom properties only; it must not switch a discrete layout enum on each width change.
- During transitions, use transforms or CSS variables to position the brand and CTA, avoiding title shifts when they re-enter flex layout.
- Use `text-ui-*`, semantic colors, and existing rail spacing in the Header; do not add arbitrary font sizes or hard-coded colors.
- Measure Chinese and English CTA labels at their actual intrinsic widths.
- When a read-only share has no continue button, keep the right track empty while the brand and title still use the same geometry calculations.
- This change is limited to the Web share landing-page presentation layer. Do not change the share protocol, deep links, Desktop continuous behavior, mobile `/remote`, or remote-workspace behavior.

## Acceptance

- No horizontal overflow at widths of 320px, 768px, 1280px, 1920px, or 2560px.
- When dragging the window continuously from narrow to wide or wide to narrow, the brand and CTA x-coordinates change monotonically. Keep each outside anchor while its corresponding side has sufficient space; move inward toward the content column only after space runs out.
- Header height and vertical centering remain stable. The title does not cover the CTA, and the CTA does not cover the title.
- Chinese and English, long and short titles, read-only and importable shares, and light and dark themes all work.
- With no theme preference, open in light mode. After clicking the theme button, the page, Markdown content, and button styles switch together, and the choice persists after refresh.
- Under `prefers-reduced-motion`, add no extra easing; geometry positions must still update continuously.
