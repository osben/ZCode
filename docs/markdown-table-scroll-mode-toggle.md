# Markdown table scroll mode toggle

## Background

Markdown tables use a virtual horizontal scrollbar that hides the native scrollbar, and can borrow space to the left and extend right to the chat root boundary. Extended scrolling suits very wide tables, but defaulting to it for ordinary tables changes reading rhythm by taking extra horizontal space.

## Goals

- Tables compute borrowable horizontal space from the nearest `data-markdown-table-layout-root` message content root; the old `chat-view` selector stays as a compatibility path.
- Each markdown table has its own horizontal scroll mode toggle.
- The table root container sets `my-0` explicitly, overriding block margins the Markdown typography context may inject.
- Extended scrolling is off by default; the virtual scrollbar stays.
- Off: the scroll slot width is the `data-markdown-table-frame` width — no left borrow, no right extension.
- On: reuse the existing extension logic — slot width `frameRect.width + rightDistance - rightInset`, left borrowing allowed, and the left-borrowed width added to the content max width.
- Sticky scrollbar rules for long tables are unchanged: stick to the bottom only when the table itself exceeds 80% of the vertical viewport, and keep avoiding the bottom input area/panel.
- V4 virtual rows are positioned via `transform`, so native `position: sticky` cannot work relative to the timeline; long-table scrollbars must compute vertical compensation from the timeline's visible bottom edge and the actual `data-v4-composer-dock` height, clamped to the table's own top/bottom bounds. Old ChatView keeps `--chat-bottom-dock-height`.
- `data-markdown-table-virtual-scroll-sticky` is the stable semantic contract for sticky mode; E2E must read that state plus post-scroll geometry to verify sticking, never `getComputedStyle().position` — the V4 implementation deliberately uses `relative + translateY`.
- The short-table-does-not-stick vs long-table-sticks contrast must run in a fixed, tall-enough window, so a short table cannot itself exceed `80%` of the viewport and silently validate the wrong precondition; if the target size exceeds the current display work area, E2E must clamp to the work-area maximum instead of waiting for a size the OS will never grant.
- When the virtual scrollbar becomes visible again after horizontal overflow appears, it must rebind the vertical timeline listeners and geometry observers; sticky-mode state alone is not enough.
- The V4 composer dock can grow dynamically (input, attachments, panels); sticky compensation must observe the dock size directly and rebind when the dock node mounts/replaces conditionally.
- The `data-v4-back-to-bottom-anchor` floating button shown while the timeline is off-bottom is also part of the bottom avoidance area; sticky compensation additionally subtracts the button height plus `8px` spacing, and button mount/unmount must trigger recomputation.
- Within one geometry pass, virtual scrollbar visibility must be decided only by the stable floating-point layout slot width, never by reading the DOM track width after conditional mounting.
- Horizontal-overflow state changes may only toggle the virtual scrollbar's visibility/interactivity; they must not mount/unmount nodes or change vertical placeholders, to avoid disturbing V4 timeline `scrollHeight` / `scrollTop`, bottom-follow state, or session scroll memory.
- The V4 composer fade mask must hang on the full-width message mask layer of the timeline; body column width, centering, and horizontal panel offset belong to `data-v4-timeline-virtual-history` and the live tail. The mask layer must not reuse the body column's `max-width`, or the parts of extended mode that extend past the body column get clipped by the CSS mask.

## Interaction

The toolbar adds a mode button to the right of "preview table":

- Shown only when the table overflows horizontally at normal frame width and extended mode provides extra visible width or left-borrow space.
- Off: the button means expand the table scroll area. On: it means collapse back to the normal scroll area.
- The mode affects only the current table instance.
- Once on, the button stays visible for easy collapse; after collapsing, it hides if extended mode has no benefit at the current size.
- The virtual horizontal scrollbar node stays always mounted with a fixed vertical placeholder; without horizontal overflow it only becomes invisible and non-interactive, never unmounted. With overflow it still appears only on hover over the current `data-markdown-table-frame`, to avoid stealing attention during normal reading.
- On expand/collapse, only the content max-width change without left borrowing uses a light transition; once left borrowing happens, the content layer's offset and max width apply immediately, so the table never slides left or stretches. The virtual scrollbar slot width keeps a light transition; transitions are dropped under reduced motion.

## Calculation

The V4 timeline scroll viewport must be marked `data-markdown-table-layout-root="true"`. The marker expresses only the horizontal layout boundary tables may expand to; it carries no session-state semantics. The root provides responsive safe insets via `--markdown-table-layout-left-inset` / `--markdown-table-layout-right-inset`; with a Conversation turn map, the left inset must cover at least its `48px` width; the right inset stays `16px` desktop, `8px` mobile Web. A table must not mistake the centered message content column for its expansion boundary.

Normal mode:

- `scrollbarWidth = frameRect.width`
- `viewportMaxWidth = frameRect.width`
- `maxViewportLeftOffset = 0`
- `viewportLeftOffset = 0`
- `virtualScrollLeft = realScrollLeft`
- `virtualScrollMax = tableWidth - scrollbarWidth`

Precision invariants:

- `scrollbarWidth` keeps the sub-pixel precision of `getBoundingClientRect()` and writes the same value into the CSS width and the `virtualScrollMax` computation.
- Keep the existing `virtualScrollMax > 1px` visibility threshold; the fix neither widens nor narrows the horizontal-overflow product semantics.
- The DOM track's actual width participates only in thumb ratio and visual position; it must not decide whether the track itself is mounted.

Extended mode:

- `scrollbarWidth = frameRect.width + rightDistance - rightInset`
- `viewportMaxWidth = scrollbarWidth`
- `maxViewportLeftOffset = max(0, frameRect.left - rootRect.left - leftInset)`
- `viewportLeftOffset = min(virtualScrollLeft, maxViewportLeftOffset)`
- `virtualScrollLeft = viewportLeftOffset + realScrollLeft`
- `virtualScrollMax = tableWidth - scrollbarWidth`
