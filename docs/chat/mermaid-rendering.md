# Mermaid Rendering

## Scope

- Fenced code blocks marked `mermaid` / `mmd` in chat messages, Markdown preview and tool output render as Mermaid diagrams. An unlabeled plain-text code block whose first line is clearly Mermaid diagram syntax also renders automatically.
- The right-side code viewer shows the diagram directly for `.mmd` / `.mermaid` files.

## Implementation

- Language detection goes through `packages/ui/src/lib/mermaidLanguage.ts` so entry points do not hand-write the check.
- The diagram component is `packages/ui/src/components/ai-elements/mermaid-block.tsx`. It uses the Mermaid instance from `@streamdown/mermaid` and builds Mermaid `themeVariables` from the current theme tokens.
- Mermaid rendering runs through a module-level serial queue so several diagrams initializing Mermaid global config at once do not overwrite each other's theme.

## Zoom preview

- The entry sits in the code block header action area, left of the copy button, always visible on desktop and mobile; disabled until the diagram has rendered. Clicking it or double-clicking the diagram area opens the preview dialog.
- The dialog is hosted by the generic diagram preview component: a near-fullscreen Dialog on desktop, the full available viewport on mobile. It shows only the rendered SVG; it does not re-interpret Markdown or change streaming message boundaries.
- On open it zoom-to-fits the dialog viewport and the SVG's visible graphic bounds (small diagrams also scale up within the zoom cap; the outer Mermaid background canvas is excluded from fit). The toolbar offers zoom in, zoom out, a zoom menu (zoom to 50% / 100% / 200%, zoom to fit, reset zoom) and close. Shortcuts: `Esc` closes, `+` / `-` zoom.
- The viewport supports mouse-drag pan, wheel pan and zoom at the pointer position. A macOS trackpad pinch arrives in the browser as a `ctrlKey` wheel event and is interpreted as zoom centered on the pointer; an ordinary two-finger scroll stays pan.
- Mobile Web supports one-finger drag pan and two-finger pinch zoom via Pointer Events. All gestures are captured only inside the dialog content area, so the chat list, remote replayable message recovery and the desktop continuous main path are unaffected.
- The diagram theme keeps reusing the current Mermaid themeVariables; the preview container uses design tokens such as `--color-popover` / `--color-border` / `--color-foreground`, compatible with light, dark and Zai themes.

## Mermaid code block SVG style

Diagrams are still shown as inline SVG by `packages/ui/src/components/ai-elements/mermaid-block.tsx`; `code-block.tsx` removes the outer backing plate and the language title only in the Mermaid render branch.

- Diagrams use SVG text labels; default node and edge labels use the existing surface, border and foreground colors, and lines stay thin. Text reuses the host sans-serif font and body size.
- The diagram area and the outer code block have no separate background, border or rounded plate; they blend into the message body. No language name or file icon is shown; copy and zoom stay on the right. Ordinary code blocks and streaming source keep their title and plate.
- Colors and shapes that the source sets explicitly are kept.
- A diagram shrinks to the code block's available width, keeping proportions and selectable text; Chinese, multi-line and narrow screens cause no horizontal overflow outside the code block. Large diagrams can use the existing zoom preview.
- Existing copy, zoom preview, streaming boundary, render queue and error fallback are kept.
- No change to the global theme, theme sync, Gen UI or visualize; no new theme layer, render framework, cache or layout engine.

Acceptance: flowchart, sequence and explicit color/shape samples in light and dark themes and at desktop/mobile width; check SVG text, edge labels, size, source fallback and the existing zoom preview. Commit only after runtime evidence and code checks are done.

## Streaming boundary

While a chat message is still streaming, a `mermaid` code block shows its source; once the message completes it switches to the diagram. This avoids unclosed or half-written Mermaid source repeatedly triggering render errors during streaming updates.
