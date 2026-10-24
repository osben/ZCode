# CodeViewer @pierre/diffs rendering

`packages/ui/src/components/ui/code-viewer.tsx` renders code files through the `@pierre/diffs` model:

- Preview files are expressed as `FileContents`: `name`, `contents`, `lang`, `cacheKey`.
- Rendering uses the `File` component from `@pierre/diffs/react`, which owns code lines, line numbers, and annotations.
- Only code-preview parameters remain: language, highlight toggle, line numbers, wrapping, theme, and font size.

Markdown code blocks use CodeViewer for read-only display; comments are not supported.
