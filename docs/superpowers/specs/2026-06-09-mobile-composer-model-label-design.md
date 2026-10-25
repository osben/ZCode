# Mobile Composer Model Label Design

The mobile web remote chat composer always shows the current model name in the bottom input controls. Long names stay on one line and truncate in the middle rather than hiding the label or expanding the composer.

Context: the composer renders toolbar controls into the prompt editor submit area through portals, and the model selector used to share the mode/thought `labelVisibilityClassName`, which hides labels on narrow widths — leaving icon-only controls even with a model selected.

Rules:

- The model selector trigger always renders a visible model label in composer controls, including mobile web remote viewports.
- Display length is capped at `deepseek-v4-flash`'s 17 characters; longer labels truncate in the middle as `7 left + ... + 7 right` (total 17). The full name stays available via the trigger title.
- Desktop labels keep default-visible behavior and do not inherit the mode/thought responsive hide class.
- Custom provider prefixes stay hidden until `@2xl/composer`; the model name can stay visible from the existing `sm` boundary to avoid `providerName/` width pressure at medium widths.
- Mode and thought-level controls keep their responsive label visibility.
- Selector menu behavior, shortcut, disabled/pending state, focus restoration, and provider selection logic are unchanged; presentation-only, so `desktop-continuous` and `web-remote-replayable` semantics are unaffected.

Verification: regression tests assert the desktop label stays visible by default and the mobile label class remains visible with bounded truncation classes (`packages/ui/test/modelConfigSelect.test.ts`).
