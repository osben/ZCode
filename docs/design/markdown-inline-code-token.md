# Markdown Inline Code Token

Markdown inline code uses an independent background token `--color-markdown-inline-code`.

## Design Constraints

- `--color-markdown-inline-code` maps to `--color-tag`, expressing a lightweight capsule label, not promoted to the card level.
- Inline code text continues to inherit the Markdown body's `--color-foreground`, ensuring reading continuity.
- Code blocks do not use this token; they continue to be controlled by CodeBlock / CodeViewer's code theme.
- `font-mono` uses a cross-platform CJK-safe font stack: Latin characters prefer monospace fonts, Simplified Chinese falls back to `Microsoft YaHei UI` / `Microsoft YaHei` on Windows, `PingFang SC` on macOS, and `Noto Sans CJK SC` on Linux. Chinese must never fall through to the generic `monospace` serif font.
- CodeViewer / DiffViewer must reuse the same font stack via `--diffs-font-family: var(--font-mono)`, and must not fall back to `@pierre/diffs`'s built-in fallback without CJK sans-serif fonts.

## Implementation Locations

- Token defined in `packages/ui/src/styles.css`.
- Markdown inline code rendered in `packages/ui/src/components/ai-elements/message.tsx`.
- Markdown code block, file preview, and full diff font mapping located in `packages/ui/src/components/ui/code-viewer.tsx` and `packages/ui/src/components/ui/diff-viewer.tsx`.
