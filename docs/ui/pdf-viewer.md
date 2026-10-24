# PDF Viewer

`packages/ui/src/components/ui/pdf-viewer.tsx` is the generic read-only `PdfViewer` preview component,
wrapping the `react-pdf` dependency. It only renders and handles browsing interaction; it offers no
editing or annotation. PDF data is supplied by the caller.

## Rendering

- The pdf.js worker is imported via Vite `?url` from `pdfjs-dist/build/pdf.worker.min.mjs` and
  `GlobalWorkerOptions.workerSrc` is set once at module load; the `?url` type declaration comes from
  `packages/ui/src/assets.d.ts`.
- The Vite builds of Desktop and Web must both publish `pdfjs-dist/cmaps` under `pdfjs/cmaps/` at the
  current build base. `PdfViewer` uses one stable module-level options set for all sources (whole file and
  range), passing `cMapUrl` and `cMapPacked: true`; otherwise CJK PDFs that use predefined CMaps such as
  `UniGB-UCS2-H` without embedded character maps lose non-Latin text in pdf.js. CMap requests read only the
  app's own static assets and never enter the workspace file service, Host/relay or the task
  continuous/replayable message chain.
- The `source` prop accepts `string` (URL / data URL), `Blob`, `ArrayBuffer`, `Uint8Array`, and the range
  variant `{ totalBytes, initialData?, requestRange(offset, length) }` for on-demand segment loading of big
  files. It is memoized into react-pdf's `file` input so reference changes do not reload the document.
  Binary input is copied before handing to pdf.js, so the worker transfer cannot detach the caller's
  buffer.
- The range variant builds a pdf.js `PDFDataRangeTransport` (`requestDataRange` -> `requestRange` ->
  `onDataRange`) with module-level constant options `disableAutoFetch` / `disableStream` and
  `rangeChunkSize = 256KB` (aligned with the service layer's default `readFileRange` segment size),
  fetching only the byte segments the current page needs. A failed segment request shows the load-failure
  text and calls `onLoadError`; the transport is `abort()`ed on document switch/unmount.
- Single-page mode: one page at a time; when the page exceeds the container the content area scrolls
  itself, when smaller it is centered horizontally.
- The text layer stays on (select and copy); the annotation/link layer is off so links inside the PDF do
  not trigger a whole-window navigation on desktop.
- Loading, load failure and empty document render text hints; copy is injected via the `labels` prop
  (English by default), and the component does not depend on intl directly.
- Switching `source` resets to page 1 and 100% zoom.
- The component is lazy-loaded into the preview pane by `packages/ui/src/previewPanePdfContent.tsx`, so
  react-pdf stays out of the main bundle.

## Bottom Action Bar

- Layout: separated by `border-t`, controls centered: previous-page button, page input + `/ total pages`,
  next-page button, divider, zoom-out button, zoom percentage, zoom-in button.
- Zoom: default `100%`, button step `25%`, range `25%`-`400%`; the matching button is disabled at a limit.
- Paging buttons: page 1 disables previous; the last page disables next.
- Page input: controlled draft value, submitted on Enter or blur; a parse failure restores the current
  page; out of range clamps to the valid range.
- While the document is not loaded, all action-bar controls are disabled.

## Paging Interaction

- Keyboard: the component container has `tabIndex=0`; when focused, `ArrowLeft` / `ArrowRight` page back /
  forward; with focus in the page input, arrow keys are not intercepted so the caret semantics stay.
- The wheel only scrolls the current page content and does not page.
- After paging (button, keyboard, page jump) the scroll position returns to the page top.

## Zoom Interaction

- Modifier + wheel zooms continuously: `command` on macOS, `ctrl` on other platforms (Windows/Linux), with
  platform detection reusing `isAppleKeyboardPlatform`.
- Zoom changes by `exp(-deltaY * 0.002)` (compatible with high-frequency small trackpad deltas and a large
  mouse-wheel notch delta) within the same `25%`-`400%` range as the buttons.
- Modifier + wheel is an exclusive zoom gesture and calls `preventDefault`, no longer scrolling page
  content. React's `onWheel` delegation is a passive listener and cannot `preventDefault`, so a
  non-passive native wheel listener is attached on the scroll container.
- The zoom listener is not registered before the document finishes loading, matching the disabled state of
  the action-bar controls.
- **Preview-then-commit two-stage rendering (anti-flicker)**: react-pdf hides and clears the canvas on
  `scale` change until async rendering completes, so consecutive commits flicker. The scale is therefore
  split into `displayScale` (the user-visible target, updated live by wheel/buttons) and `renderScale`
  (the value actually passed to `<Page>`): during the gesture the page layout box reserves the final width
  and height by `displayScale`, and the already rendered canvas inside gets an immediate preview via
  `transform: scale(displayScale / renderScale)` with `transform-origin: top left`; after a `200ms` pause
  `displayScale` is committed to `renderScale` at once. The target layout box has the same size before and
  after commit, so the page does not jitter from a layout-basis switch when moving from centered to
  horizontally scrolling. The zoom percentage display binds to `displayScale`.
- **Double buffering at commit**: the `<Page>` scale key unmounts the old canvas while the new canvas is
  hidden until async painting completes. Before committing, the currently painted canvas is copied to an
  overlay with the target layout box width/height directly, and the overlay is removed only when the new
  canvas's `onRenderSuccess` arrives. The old-bitmap overlay and the new canvas share the same top-left and
  target size, so button zoom, continuous wheel zoom and fast target changes show no blank frame or
  noticeable misalignment.
- **Pointer scroll anchoring**: before modifier + wheel zoom, record the normalized coordinates of the PDF
  content point under the pointer; after `displayScale` updates and the target layout box reflows, correct
  `scrollLeft` / `scrollTop` in `useLayoutEffect` so the same content point stays under the pointer as far
  as possible. Zoom buttons without pointer coordinates use the viewport center. The real canvas commit no
  longer compensates afterward with half the `scrollWidth` difference, because the layout box is stable
  across the commit.

## Related Files

- `packages/ui/src/components/ui/pdf-viewer.tsx`: component implementation (incl. `PdfViewerRangeSource`
  and the `PDFDataRangeTransport` adapter).
- `packages/ui/src/components/ui/usePdfZoomOverlay.ts`: zoom layout, pointer anchoring and the commit-stage
  canvas double-buffer overlay.
- `packages/ui/src/previewPanePdfContent.tsx`: the preview pane's lazy-loading layer.
- `packages/ui/src/assets.d.ts`: type declaration for Vite `?url` asset imports.
- `packages/services/src/file/fileService.ts`: `readFileRange` segment reads and the `stat` `size` field
  (data source for range loading).
- `docs/ui/preview-pane.md`: the preview pane's `pdf` source dispatch and data-loading policy.
