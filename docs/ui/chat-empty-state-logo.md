# New Task Empty State Logo

## Background

The New Task empty-state title is the first-screen prompt for creating a task after entering a project. It carries a ZCode brand mark without hurting text readability or layout stability.

## Design

- A decorative ZCode SVG logo sits behind the `ChatViewEmptyState` text.
- The logo keeps its original `400x320px` ratio and shrinks on mobile with `min(72vw, 25rem)` to avoid horizontal overflow.
- The logo stroke uses `currentColor`, inheriting the outer container's `foreground-subtlest` semantic color, with `opacity-70`, a lower level than body `foreground`; it adapts to light and dark themes automatically.
- The logo container has a fixed `400:320` ratio and sets a standard CSS mask plus `-webkit-mask-image` through Tailwind arbitrary properties, fading from the top to fully transparent at `70%` height. This is compatible with the Electron/Chromium rendering path; the mask is not written on the SVG element directly.
- The logo is shifted up by `-mt-10` relative to the title center so the graphic stays mostly behind and above the title, reducing the visual interference of the bottom fade area on the input area.
- The logo uses `aria-hidden` and `pointer-events-none`: it is not read by assistive technology and does not intercept input.
- The text sits above the logo at a higher layer, using a `text-3xl` serif font for brand feel; existing i18n copy and layout are unchanged.
