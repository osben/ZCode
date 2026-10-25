# Preview Pane

## Goal

The right Preview Pane previews tool calls, file links and workspace files in a side pane tab. It only
displays and does not parse business semantics; the preview data is built by
`packages/ui/src/lib/codeViewer.ts` and the caller into a `CodeViewerSource` and passed in.

## Supported Preview Types

- `file`: reads the real file content by path; a text file up to `256KB` is read in one go, over the limit a
  localized large-file hint shows; a binary file is dispatched to a dedicated preview adapter by file type
  (currently image, media, PDF, PPTX), and unadapted types still show a cannot-preview hint.
- `text`: renders in-memory text with code highlighting by `language`.
- `patch`: renders a unified diff / patch, keeping add/remove line semantics.
- `image`: reads a media preview and shows the image; currently recognizes `apng`, `avif`, `bmp`, `gif`,
  `ico`, `jpeg`, `jpg`, `png`, `svg`, `webp`.
- `media`: previews MP4, MOV, WebM, M4V, MP3, WAV, M4A, OGG, Opus, FLAC and WEBA with native `video` /
  `audio` controls; Desktop local files use an authorized `zcode-media://` URL, Desktop SSH/WSL/Docker files
  use the Host loopback HTTP Range Proxy, and mobile `/remote` uses only workspace-scoped small-file inline
  reads.
- `pdf`: renders a read-only PDF preview (currently `pdf`), preview only, no editing. All entries create a
  `file` source and PreviewPane's `resolvePreviewPanePdfSource` lazily upgrades it to `pdf` (same upgrade
  pattern as image), so the tab key always de-duplicates via `file:{path}`. Data loading goes through
  segmented reads of `fileService` (`stat` for size; below `2MB` it loops `readFileRange` to fetch all, above
  that pdf.js range loads on demand), with no whole-document size limit; an old remote (`stat` returns no
  `size`) falls back to the old whole-document base64 `readMediaPreview` channel, keeping its 8MB limit.
- `office`: previews `.xlsx`, `.xlsm`, `.xls`, `.docx` and `.doc` read-only; Excel's fully supported path is
  `.xlsx`, `.xlsm` / `.xls` show only data the render library can parse, and `.docx` / `.doc` both go to the
  Word renderer.
- `pptx`: renders a read-only PPTX preview (currently `.pptx`) with a left vertical thumbnail list and a
  right single-page preview; the bottom toolbar offers paging, page-number jump and zoom. All entries still
  create a `file` source and PreviewPane lazily upgrades it to `pptx`, so the tab key keeps de-duplicating via
  `file:{path}`. Phase one implements only `PresentationPreviewEngine`; editing, export and write-back keep
  only layered interfaces. A new Host uses a `64MB` limit; an old remote lacking `stat.size/readFileRange`
  keeps an `8MB` base64 compatibility limit and shows an independent localized hint rather than misreporting
  `64MB` or leaking the remote path. Details: `docs/ui/pptx-preview.md`.

## File and Text Rendering Rules

- `.md` / `.markdown` files and markdown text sources enter preview mode by default and can switch to source
  from the more menu.
- `.svg` files and text sources with a `.svg` path enter SVG preview by default and can switch to code; in
  code mode the word-wrap switch is still usable.
- Image preview uses a 4px mosaic background and the content area keeps `p-10`; a bitmap shows at natural size
  by default, and for a file name with `@2x`, `@3x`, `@1.5x` etc. it is converted to the matching CSS display
  size and still bounded by the container's max width/height; SVG, as a vector, fits the container by
  `contain` and takes no part in bitmap scale conversion.
- Office files read the full binary content through the workspace-scoped `fileService` with a 25 MB
  cross-RPC limit; renderers and WASM assets load lazily by file type, so ordinary text and image previews
  carry no extra first-screen burden.
- Excel preview uses the current Zai Light / Dark theme; DOCX pages keep white-paper semantics, and both
  desktop and mobile Web can scroll inside the preview container to reach the full content.
- Ordinary code files use Shiki-token syntax highlighting, and the more menu offers a word-wrap switch.
- Code source renders line by line: each line has a non-selectable `line` number area and a selectable `code`
  content area. On horizontal scroll the `line` area stays sticky; with word-wrap on, only the `code` area
  wraps.
- Ordinary text/code files have a `256KB` preview cap: within it, one read and one complete document render
  keep UTF-8 decoding, line numbers and scroll context continuous; over it no partial content renders and a
  localized hint guides the user to open with another editor. The `256KB` cap constrains only ordinary
  text/code preview; PDF, PPTX and Office files keep their own binary reads, size limits and render chains.
- A `.pdf` file enters the PDF read-only preview, rendered per page with scroll browsing; no source view
  switch, and this version offers no editing or annotation.
- The generic top title bar of Word, Excel, PPTX and PDF document previews must show a `border-border`
  horizontal divider below it; ordinary code, image and Markdown previews keep the original divider-free title
  bar.
- A `.pptx` file enters the PPTX read-only preview, mounting only the selected page in the main area; no source
  view, built-in editing, export or save, but the top bar keeps the same generic "Open in external editor"
  button as XLSX and DOCX, which is not in-Preview-Pane editing or write-back.

## Path Handling

- At the entry, Preview Pane normalizes the `CodeViewerSource`, restoring URI escapes in local paths, e.g.
  `Auto%20Snake` is shown and read as `Auto Snake`. The side pane runs the same normalization before building
  the tab key, so one file is not opened as two tabs through `%20` vs space.
- A path is used only for path semantics such as file read/write and opening in an editor; workspace
  isolation still follows `workspaceIdentity?.trim() || workspacePath`.

## Breadcrumb Behavior

- The top breadcrumb prefers showing `workspace -> directory -> file` by the current workspace.
- A long path scrolls horizontally without squeezing the file-name area. On first open or after a source
  switch the breadcrumb scrolls to the far right by default, showing the trailing directory and file name
  first.
- Edge masks show only when there is scrollable content; at the left, middle and right positions they show a
  right, both-side and left fade respectively.

## Related Files

- `packages/ui/src/PreviewPane.tsx`: pane shell, breadcrumb, view switching and file read lifecycle.
- `packages/ui/src/components/ui/code-viewer.tsx`: the generic `CodeViewer` Shiki code viewer, handling
  line-by-line rendering, sticky line numbers and wrap policy; the side pane and later markdown code blocks
  reuse the same entry.
- `packages/ui/src/components/ui/pdf-viewer.tsx`: the generic `PdfViewer` read-only PDF preview component,
  per-page rendering and scroll browsing, dispatched by the preview pane's `pdf` source, no editing capability;
  see `docs/ui/pdf-viewer.md`.
- `packages/ui/src/previewPanePdfContent.tsx`: thin wrapper of the pdf body, lazy-loading `PdfViewer`
  (react-pdf is large and enters the bundle only on first PDF preview open).
- `packages/ui/src/previewPanePptxContent.tsx`: thin wrapper of the pptx body, lazy-loading the PPTX preview
  component and `@aiden0z/pptx-renderer`.
- `packages/ui/src/lib/shikiHighlighter.ts`: the generic Shiki highlight cache and async tokenization entry,
  so `components/ui` does not depend on `ai-elements` implementation details.
- `packages/ui/src/previewPaneContent.tsx`: dispatches body rendering by `CodeViewerSource` type.
- `packages/ui/src/previewPaneOfficeContent.tsx`: Office binary decoding, lazy loading and the unified error
  boundary.
- `packages/ui/src/previewPaneOfficeXlsxContent.tsx`: Excel read-only rendering and theme adaptation.
- `packages/ui/src/previewPaneOfficeDocxContent.tsx`: DOCX parsing, white-paper theme and responsive
  container.
- `packages/ui/src/lib/officeFilePreview.ts`: Office extension recognition and base64 decoding.
- `packages/ui/src/lib/codeViewer.ts`: preview source types, tool-call preview extraction, language and image
  type recognition.
- `packages/ui/src/lib/codeViewerSource.ts`: Code Viewer source path normalization.
- `packages/ui/src/lib/workspaceSidePane.ts`: Code Viewer tab key generation and reuse.
- `docs/ui/office-file-preview.md`: boundary, state combinations and verification contract of Office preview.
