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

## Streaming boundary

While a chat message is still streaming, a `mermaid` code block shows its source; once the message completes it switches to the diagram. This avoids unclosed or half-written Mermaid source repeatedly triggering render errors during streaming updates.
