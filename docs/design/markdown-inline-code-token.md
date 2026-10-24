# Markdown inline code token

Markdown inline code uses an independent background token `--color-markdown-inline-code`.

## Design constraints

- `--color-markdown-inline-code` maps to `--color-tag`, expressing a lightweight capsule label, not promoted
  to card level.
- Inline code text keeps inheriting the Markdown body's `--color-foreground`, for reading continuity.
- Code blocks do not use this token; they stay controlled by the CodeBlock / CodeViewer code theme.
- `font-mono` uses a cross-platform CJK-safe font stack: Latin prefers monospace fonts, Simplified Chinese
  falls back to `Microsoft YaHei UI` / `Microsoft YaHei` on Windows, `PingFang SC` on macOS and
  `Noto Sans CJK SC` on Linux. Chinese must never fall through to the generic `monospace` serif font.
- CodeViewer / DiffViewer must reuse the same font stack via `--diffs-font-family: var(--font-mono)` and must
  not fall back to the built-in fallback of `@pierre/diffs`, which has no CJK sans-serif fonts.

## Implementation locations

- Token defined in `packages/ui/src/styles.css`.
- Markdown inline code rendered in `packages/ui/src/components/ai-elements/message.tsx`.
- Markdown code block, file preview and full diff font mapping in `packages/ui/src/components/ui/code-viewer.tsx`
  and `packages/ui/src/components/ui/diff-viewer.tsx`.
