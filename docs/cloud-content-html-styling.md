# Cloud content description HTML styling

Scope: the HTML attributes of `description.format=html` only; the interface
structure, outer description.style, Hero ZIP, polling, and reporting are unchanged.

```text
server content -> inert template -> tag filtering / class merging / style validation -> React nodes
```

The only render entry is CloudDialogDescription, with no new async state; Desktop
and Web share it, and continuous/replayable transport is untouched.

## class

There is no runtime whitelist; unknown class names are kept. The server-side
convention is Tailwind. Conflicts merge via the existing
cn(tag default classes, cloud classes). Only CSS already bundled into the App takes
effect — no runtime compiler runs and no remote CSS is loaded. The `@source inline`
in styles.css only keeps commonly used utility classes of the current templates
stably bundled; it is not a filter for delivered classes.

Because classes can use bundled layout/positioning utilities, this capability is
only for content maintained by a trusted server; it does not claim HTML styling is
safely isolated. Specificity and selector precedence still follow CSS.

## inline style

Full declarations are parsed via CSSStyleDeclaration on a not-yet-mounted element,
then filtered per property and value into React CSSProperties; invalid declarations
are dropped individually. Arbitrary variable definitions, resource URLs, escaped
values, !important, and positioning/sizing/z-index/transform/animation are
forbidden.

| Property                                                           | Accepted values                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| color / background-color / text-decoration-color                   | Browser-recognized colors, currentColor; exact var(--color-foreground), foreground-subtle, foreground-subtlest, foreground-inverse, primary, primary-foreground, secondary, brand, icon-blue, success, warning, destructive, popover, surface, background tokens, no fallback |
| font-size                                                          | exact var(--text-ui-xl/lg/base/caption/sm/xs); arbitrary sizes are not allowed                                                                                                                                                                                                |
| font-weight / font-style                                           | 1..1000, normal/bold/bolder/lighter; normal/italic/oblique                                                                                                                                                                                                                    |
| line-height                                                        | normal or a unitless 1..3                                                                                                                                                                                                                                                     |
| text-align                                                         | start/end/left/right/center/justify                                                                                                                                                                                                                                           |
| white-space                                                        | normal/nowrap/pre/pre-wrap/pre-line/break-spaces                                                                                                                                                                                                                              |
| overflow-wrap / word-break                                         | normal/break-word/anywhere; normal/break-all/keep-all/break-word                                                                                                                                                                                                              |
| text-decoration / text-decoration-line / text-decoration-style     | legal combinations of none/underline/overline/line-through with solid/double/dotted/dashed/wavy; color and thickness use their own properties                                                                                                                                 |
| text-decoration-thickness / text-underline-offset / letter-spacing | 0..32px, 0..2rem/em or unit zero; also auto/from-font or normal (per property)                                                                                                                                                                                                |
| margin / padding and top/right/bottom/left                         | 1..4 non-negative finite lengths, single values 0..32px or 0..2rem/em; percentages, auto, and calc are rejected                                                                                                                                                               |

Default tag styles follow the previous implementation; allowed inline styles
override classes by normal CSS precedence. Safe tags, link host callbacks, the
20,000-character/32-depth over-limit plain-text fallback, and plain_text/markdown
not interpreting HTML are unchanged.

## Acceptance

Test-first: a full user class example, unknown classes kept, class vs default-style
conflict, inline style precedence, unsafe value rejection, event/tag/link
regressions, links without a callback, legacy content regression. App E2E delivers
HTML over isolated HTTP and verifies real computed styles and unchanged reporting;
narrow-screen and light/dark checks are not a substitute for real mobile/OS devices.

Known limitations: Windows/Linux/mobile real devices, real server delivery, and a
full Web build are not verified; the App does not claim arbitrary Tailwind classes
can be generated dynamically.
