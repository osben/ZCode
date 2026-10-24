# PPTX Preview

## Goal

Phase one provides a read-only `.pptx` preview in the workspace Preview Pane. The preview uses
`@aiden0z/pptx-renderer` to parse OOXML in the Renderer and render the selected slide as DOM. The user can
explicitly enter "Select element" mode and add a specific element to the current main Composer as a
structured reference; the Agent then uses the official PPTX skill to validate the reference by
fingerprint, locate it in OOXML and write back narrowly.

The Preview Pane offers no DOM editing, PPTX export or direct write-back. Desktop can export the current
read-only render to a new PDF, but interfaces must be split by capability, and later work must not depend
on the private DOM structure of `@aiden0z/pptx-renderer`. The Preview Pane header keeps the same generic
"Open in external editor" button as XLSX and DOCX; that action leaves the built-in preview and is not an
in-PPTX editing capability.

## Product Boundary

- Only `.pptx`; `.ppt`, `.pptm`, encrypted or corrupt files are out of phase one.
- The built-in preview stays read-only, with no DOM edit, PPTX save or collaboration entry. Desktop shows
  "导出为 PDF" (Export as PDF) when the platform provides both `printPageToPdf` and `saveFile`; Web and
  mobile `/remote` do not show the Electron-only entry.
- PDF export creates a new local `.pdf`; it does not overwrite the source PPTX nor write back to a remote
  workspace. The output is the Chromium print result of the current `pptx-renderer` DOM, not a native or
  lossless PowerPoint/WPS conversion.
- Element references support only slide-owned `shape`, `picture`, `chart`, `table` and `table-cell`.
  master/layout elements, the group itself and non-text children inside a group produce no selectable
  reference; text inside a group can be a shape text reference.
- Ordinary clicks keep serving hyperlinks and other preview interaction; element overlays take over
  clicks only after the user explicitly enables "Select element" mode.
- Selecting an element first shows a local selected state, then the user runs "添加到当前任务" (Add to
  current task); no prompt is sent automatically.
- A reference goes only to the current focused/primary Composer, isolated by
  `workspaceKey + remoteSessionId + draft/session scope`; identical source path, fingerprint, slide part,
  node id and table cell coordinates are de-duplicated exactly.
- The Composer aggregate chip only expands the reference list; a concrete reference item opens the PPTX
  and tries to locate the `slideIndex` captured at reference time. Draft references and read-only
  references restored from history user rows use the same navigation semantics.
- Before reference navigation starts, the Preview Pane must leave element-selection mode and clear the
  locally selected element. Navigation only locates file and page: it does not restore selection mode,
  highlight the old element or modify the structured reference.
- File-missing and page-missing use two independent toasts. As long as the file can still be opened, the
  file preview must expand even if the referenced page no longer exists: a newly opened file stays on the
  default page, an already open same file keeps its current page; a clamped other page must not be
  disguised as a successful location.
- If the file fingerprint changed but the original page still exists, navigation still goes to that page
  with a non-blocking toast that content may differ from reference time. File/page navigation failure does
  not affect Composer drafts or history references.
- The header shows the generic Preview Pane "Open in external editor" button, using the same editor
  selection, capability check and `IPlatformService.openInEditor()` chain as XLSX and DOCX; it does not
  change the read-only boundary nor carry write-back semantics.
- Full PowerPoint fidelity is not promised: animation, transitions, formulas, OLE, full EMF/WMF and real 3D
  degrade per the current `pptx-renderer` capability.
- Final UI acceptance is done manually on Desktop and mobile Web.

## Auto-Reload of an Opened File

A PPTX opened in a Preview Pane tab must watch its source directory. When a Host file-watch event hits the
current `source.path`, the Preview Pane re-reads the complete file bytes and hands the new `ArrayBuffer` to
the viewer generation lifecycle. Watcher, file read and preview state must not live in desktop main,
relay, Agent runtime or conversation snapshot.

```text
open PPTX tab
  -> workspace-scoped fileWatcherService.watch(parent directory)
  -> watcher subscription ready
  -> initial stat + range read + final stat
  -> viewer generation N

target file changed / renamed / recreated
  -> debounced directory event
  -> reload generation latest-wins
  -> stat + range read + final stat
     |-- complete -> dispose viewer N -> reset local preview state -> viewer N+1
     |-- stale read -> ignore; latest generation owns the result
     |-- missing/invalid -> show existing localized read error; keep directory watcher alive
```

### Boundary Decisions

| Boundary | Decision |
| --- | --- |
| Watch target | Watch the parent directory, not a file handle, to support PowerPoint/WPS temp-file plus atomic-rename saves |
| Target filter | `FileWatchEvent.changedPath` is optional; ignore when it clearly names another file; old Hosts or unknown-path events reload conservatively |
| First read | Establish the watcher subscription before reading, so a save before the subscription cannot leave the preview on an old version |
| Concurrency | Watcher events only bump the reload generation; old range reads, parses and renders must not commit state |
| State reset | After new bytes are accepted: back to page 1, 100% zoom, leave element selection, clear the selected element and unconfirmed AI edit draft |
| Composer references | Structured references already in the Composer or history keep their original fingerprint and are not deleted or rewritten by a reload |
| Local/remote | Keep selecting the existing Host watcher/file service through `useWorkspaceServices(workspacePath, remoteSessionId, workspaceIdentity)` |
| Delivery | Preview reload is a renderer-local projection and does not enter the desktop continuous or web remote replayable message flow |
| PDF export | The export transaction is unchanged; a document generation being exported is not reused by async watcher callbacks, and failures use the existing export error path |

### State Combinations and Pruning

| Case ID | Setup | Event | Expected result | Status |
| --- | --- | --- | --- | --- |
| PPTX-RELOAD-01 | Local PPTX tab open | Same file saved | Re-read and show from default state in a brand-new viewer generation | accepted |
| PPTX-RELOAD-02 | SSH/WSL/Docker or mobile `/remote` attached to an existing Host | Same remote file saved | Only the matching workspace-scoped watcher/file service is called; the local same-path file is not read | accepted |
| PPTX-RELOAD-03 | PPTX open | Another file in the same directory changes, event carries `changedPath` | PPTX not re-read | accepted |
| PPTX-RELOAD-04 | Old Host or platform watcher gives no concrete changed path | Directory event received | Conservatively re-read the current PPTX | accepted |
| PPTX-RELOAD-05 | Consecutive saves or multiple events during a write | Several concurrent reads | Only the latest reload generation may commit bytes, errors and loading state | accepted |
| PPTX-RELOAD-06 | File deleted while the tab stays open | Deleted then recreated | Missing error first; parent-directory watcher kept; preview recovers after recreate | accepted |
| PPTX-RELOAD-07 | Existing Composer PPTX reference | Source file reloads | Viewer-local selection cleared, Composer reference keeps its original fingerprint | accepted |
| PPTX-RELOAD-08 | Not opened or tab closed | File changes | No watcher exists, no read triggered | pruned: no visible preview owner |

This capability involves no conversation/session state combinations, so no conversation E2E case catalog
or coverage matrix is added. Automation covers service, hook and viewer lifecycle; real Office save
behavior and UI refresh are verified manually per platform.

## PDF Export

Desktop PDF export reuses the same `PresentationPreviewDocument`, creates a one-off full print DOM in the
Renderer, waits for page render handles, fonts, image decoding and two paint frames, then Desktop Main
calls `printToPDF()` on the current `webContents`. The save dialog appears only after PDF bytes are
generated; cancelling the save raises no error, and print or save failure uses the unified failure
feedback. The print DOM and render handles must be released on success, failure and cancel.

```text
viewer(document ready)
  -- export --> render pages serially in print host
               -> materialize printable font families
               -> await fonts/images/paint frames
               -> desktop main printToPDF
               -> dispose print host
               -> saveFile dialog
                  |-- canceled -> viewer(document ready)
                  |-- saved ----> success toast
                  `-- failed ---> failure toast
```

Font handling applies only to the one-off print DOM and never changes the main preview DOM:

- An installed, measurable preferred font that can enter the Chromium PDF is kept unchanged, so
  unconditional font unification does not degrade layout.
- If the PPTX font is unavailable on this system or known not to enter the current Chromium PDF, pick the
  first truly printable font from the original stack; if the whole stack is unavailable, choose a
  deterministic fallback available on the current OS by CJK/Latin text and sans/serif/monospace/narrow
  class. macOS `PingFang SC` renders on screen in the current Skia/PDF m146 but is not written into the
  PDF, so export must skip it and choose printable CJK fonts such as `Hiragino Sans GB` or
  `Arial Unicode MS`.
- Before printing, unavailable font prefixes must be removed and the truly available font put first in
  `font-family`. Waiting for `document.fonts.ready` proves neither that the system font exists nor that
  the Chromium PDF pipeline keeps the screen's implicit fallback.
- Font replacement may change character widths and wrapping, so PDF stays a "readable export within the
  current preview capability"; a fallback must not be described as original-font fidelity or native Office
  conversion.

## UI

```text
┌──────────────────────────────────────────────────────────────┐
│ Preview Pane header                                          │
│                                      [Open in editor]         │
├──────────────┬───────────────────────────────────────────────┤
│              │                                               │
│  1 [thumb]   │                                               │
│              │       [Select element] selected slide         │
│              │             ┌───────────────┐                  │
│              │             │   AI 编辑     │                  │
│              │             └──────┬────────┘                  │
│              │             ┌──────┴────────┐                  │
│              │             │ selected node │                  │
│  2 [thumb]   │                                               │
│              │                                               │
│  3 [thumb]   │                                               │
│              ├───────────────────────────────────────────────┤
│  ...         │  ‹  [page] / total  ›     −   100%   +       │
└──────────────┴───────────────────────────────────────────────┘
```

- The left side is a fixed-semantics vertical thumbnail list; the selected item uses `bg-selected` and a
  visible border.
- The main area mounts one page at a time, keeps the page aspect ratio and centers it in the available
  area.
- The thumbnail bar and bottom toolbar use `bg-surface/30`; the slide frame, thumbnail canvas and main
  preview canvas keep their existing background levels, and slide content, selected and hover semantics
  stay independent.
- The toolbar below the main area supports previous/next page, page-number input jump, zoom out, zoom
  ratio display and zoom in.
- The toolbar has an explicit "Select element" switch; once on, hover/selected overlays use stable
  element bounds and read no private `pptx-renderer` DOM class, child order or store.
- Overlapping elements hit the topmost by slide z-order; a table cell takes priority over the table
  container. A selected element first shows a context floating bar containing only "AI 编辑" (AI Edit);
  clicking it enters only a viewer-local edit-instruction draft and dispatches no reference to the
  Composer yet. The bar is replaced by a two-stage floating bar with a multi-line comment box (same style
  as code comments), "取消" (Cancel) and "添加到对话" (Add to conversation): Cancel discards only this
  instruction and returns to the "AI 编辑" menu; confirming adds the structured reference to the current
  Composer without sending a prompt and keeps the element highlighted. Empty input may still add a pure
  element reference; non-empty input is trimmed and saved as `comment`. While the comment box is open,
  keyboard input belongs to it: arrow keys only move the caret and never paginate; Esc equals Cancel
  (discard the draft and return to the "AI 编辑" menu); an Esc during CJK IME composition cancels the
  candidates and neither closes the bar nor discards the draft (read both the local state maintained from
  composition events and the platform `isComposing`, so event timing cannot invalidate one of them early);
  only with the comment box closed does Esc leave selection mode.
- When a highlighted `shape` or `table-cell` has text, native browser text selection is restored inside
  its bounds, while the highlight frame and "AI 编辑" bar stay. Drag-selecting does not change the
  structured element selection nor trigger hyperlinks or page jumps inside the PPTX; clicking another
  element outside the bounds still switches the highlight. Textless elements (picture, chart, table
  container) keep the overlay taking over the pointer.
- When "AI 编辑" runs with a non-empty browser text selection, the reference's `selectedText` stores only
  the selected text inside the highlighted element's bounds that can be verified against that element's
  full text; a selection crossing other shapes or table cells (including overlapping bounds) must filter
  out other elements' content. `text` and `textFingerprint` always correspond to the highlighted element's
  full text; Agent inspect uses the full-text fingerprint for conflict checks, and `selectedText` is only
  context for understanding the user's edit intent. With no non-empty selection attributable to the
  highlighted element, no `selectedText` is generated.
- `comment` mirrors the code-view comment semantics: it stores only the user's modification opinion for
  the current element and is an optional model instruction of the reference. Like `selectedText`, it takes
  no part in `sourceFingerprint`, `textFingerprint`, OOXML location, de-duplication or conflict checks.
  The model must first inspect the full element by the original reference, then combine `selectedText` and
  `comment` into the complete replacement text.
- The floating bar anchors to the selected element's overlay, renders through an app-level Portal, keeps a
  stable UI size (does not scale with slide zoom) and is not clipped by page `overflow-hidden`. It shows
  above the element by default, flips below when space is short, avoids the Preview viewport edges, and
  repositions with the anchor on zoom, scroll and viewport resize.
- If the runtime cannot reliably maintain the anchor after zoom, zooming must leave element selection mode
  and close the bar rather than leave the menu at stale coordinates. The current Radix Popover/Floating UI
  path supports transformed DOM anchors and should follow them first.
- Left/right arrow keys change pages; the page-number input keeps text-caret semantics.
- Narrow screens keep thumbnails, main preview and all core actions; the thumbnail bar narrows and the "AI
  编辑" bar keeps the same semantics, limited to the Preview viewport, not a separate bottom action sheet.
- The external-open button reuses the Preview Pane's generic header behavior; availability is decided by
  the current platform, workspace type and discovered external editors, and PPTX adds no selection or
  fallback rule.
- Reference list items use real button semantics (mouse, Enter, Space); delete is an independent sibling
  button that must not trigger file navigation through event bubbling. Desktop, mobile Web, Zai Light and
  Zai Dark share the semantics.

## Abstraction Boundary

Presentation capabilities are interface-isolated:

```text
PresentationCapabilities
├─ preview: PresentationPreviewEngine       # phase one
├─ edit?: PresentationEditEngine             # later: DOM editing
├─ export?: PresentationExportEngine         # later: DOM -> PPTX
└─ persistence?: Host document service       # later: workspace write-back
```

`PresentationPreviewEngine` exposes a stable page-level contract:

- `open(data)`: parse binary and return a preview document.
- `pageCount` / `pageSize`: page list and canvas size.
- `renderPage(pageIndex, container)`: render one page into the container and return a disposable handle.
- `getPageElements(pageIndex)`: return the app-owned stable element model (slide part, OOXML node id, type,
  name, text summary, bounds, z-order, table cell coordinates), only slide-owned elements in the current
  product scope.
- `dispose()`: destroy document-level resources.

Callers must not read the class, child order or inline style of third-party generated DOM for business
logic. Later editing is modeled by a separate `PresentationEditEngine` and stable element IDs; export goes
through a separate Export DOM.

The `container` of `renderPage` must be an independent leaf mount with no React children. The third-party
renderer and its `dispose`/cleanup may only add/remove DOM inside that node; React-managed nodes such as
the selection overlay and floating bar must be siblings of the leaf mount, never sharing a container or ref
with the renderer, so imperative cleanup cannot break React DOM ownership.

## Structured References and Composer

```text
Preview source bytes + source metadata
  -> sha256 source fingerprint
  -> PresentationPreviewDocument.getPageElements(page)
  -> explicit selection overlay
  -> PPTX_ELEMENT_REFERENCE_ADD event
  -> focused/primary ConversationComposer
  -> chip + hidden `# Presentation element comments:` prompt tail
```

Minimal reference structure:

```text
PptxElementReference
├─ id
├─ workspacePath / workspaceIdentity / remoteSessionId
├─ sourcePath / sourceTitle / sourceFingerprint
├─ slideIndex / slidePart
├─ nodeId / nodeType / nodeName / bounds / zIndex
├─ rowIndex? / cellIndex?                  # table-cell only
├─ text? / selectedText? / comment? / textFingerprint?
└─ capturedAt
```

- `sourceFingerprint` is `sha256:<hex>` of the complete preview bytes, not a size/mtime approximation.
- The authoritative location key is `sourcePath + sourceFingerprint + slidePart + nodeId`; a table cell adds
  `rowIndex + cellIndex`. `nodeName`, full `text`, `textFingerprint` and bounds serve only checking,
  explanation and conflict diagnosis and must not be guessed from on ambiguity; `selectedText` only
  expresses the text fragment the user cares about and `comment` only the user's modification opinion; both
  take no part in location or conflict checks. The Agent must first inspect the full element text, then
  combine these two context fields into the complete replacement text passed to `update-text`; a substring
  or an opinion must not be treated as an independent OOXML target.
- The newly sent prompt tail reuses the code-comment model semantics with the title
  `# Presentation element comments:` and a fixed declaration before the JSON: each non-empty `comment` is
  an independent user modification request for that reference, to be handled one by one and never mixed
  across references. The declaration and `comment` field go directly into the user prompt without relying
  on the model loading the PPTX skill. The legacy `# Presentation elements:` JSON tail is still parsed back
  but new references no longer generate the old title.
- The hover list of the Composer aggregate chip follows the code-comment attachment hierarchy: element
  summary and location info, then the non-empty `comment`, so each element reference and its modification
  opinion can be checked before sending.
- The prompt tail is separate from the attachment protocol and uploads no PPTX binary; a history user row,
  after parsing back, shows only body and reference chips and hides the internal structured block.
  selection, code comment, web element and presentation element use a fixed tail order, and the parser
  consumes them in reverse.
- A source switch clears viewer hover/selected state; references already in the Composer remain until the
  user deletes them, a send succeeds or the scope switches. References do not enter task
  snapshot/replayable runtime state.

State and timing:

```text
viewer idle
  -- enable selection --> selecting(no selection)
  -- click overlay ----> selecting(selected reference + anchored AI Edit bar)
  -- scroll/resize/zoom> floating bar follows transformed anchor
  -- AI Edit ---------> editing local instruction draft; composer unchanged
                       |-- arrow keys -> caret only; never paginate
                       |-- Esc while IME composing -> IME cancels candidates; draft kept
                       |-- cancel/Esc -> discard draft; return to AI Edit bar
                       `-- add to conversation -> composer receives immutable reference
                                                  with optional comment;
                                                  discard local draft and keep selection
  -- unsupported zoom -> viewer idle; floating bar closes
  -- page/source change> clear local selection
  -- Esc(no draft)/disable -> viewer idle

composer(scope A, focused)
  -- add matching A --> append/dedupe chip
  -- add scope B -----> ignore
  -- open reference ---> close viewer selection; open source file; try referenced page
                       |-- file missing -> file-missing toast
                       |-- page missing -> keep file preview + page-missing toast
                       `-- fingerprint changed + page exists -> navigate + stale toast
  -- send accepted ---> serialize tail, then clear A references
  -- blocked/error ----> keep A references
  -- switch scope -----> clear renderer-local reference draft
```

Reference navigation uses a renderer-local one-shot request and does not enter the prompt, task snapshot or
replayable runtime:

```text
PptxReferencePreviewNavigation
├─ requestId                         # clicking the same reference again still re-locates
├─ pageIndex                         # zero-based, same as the reference slideIndex
└─ expectedSourceFingerprint
```

Code Viewer tabs are still reused only by `workspaceKey + sourcePath`: a generic `file` source from the
file tree and a `pptx` source from a reference's reverse open must normalize to one PPTX resource key when
they point to the same `.pptx` path; the entry's source type is not a different file identity. `requestId`,
page index and `expectedSourceFingerprint` must not enter the stable tab key. A new navigation request on
the same file only drives the loaded viewer's local page state and must not re-range-read or re-parse the
PPTX. A remote workspace keeps using the `workspaceIdentity` and `remoteSessionId` carried by the
reference to select the existing Host file service; renderer, relay and desktop main add no file read or
navigation state.

## Agent Resolver and Write-Back

> Current state: the built-in document-skills plugin is aligned with the marketplace production `pptx`
> skill and no longer ships `scripts/pptx_reference.py`. The resolver contract recorded here (fingerprint
> validation, mutually exclusive `--replace-source` and `--output`, fail-closed conflict handling) remains
> the design baseline, but no built-in implementation currently carries it; Preview Pane structured
> references are still injected into the Composer and write-back is done on the Agent side.

The official `pptx` skill provides an inspect-before-update narrow interface; the Preview Pane stays
read-only:

```text
reference from prompt
  -> pptx_inspect_element(source, reference)
  -> read one source byte snapshot and compute whole-file sha256
  -> locate slidePart + cNvPr@id (+ table cell coordinates)
  -> validate node kind/name/text fingerprint
  -> update shape text or table-cell text in a temporary PPTX
  -> reopen/validate ZIP + OOXML + target
  -> choose output policy
     |-- default structured-reference edit -> replace source path
     |-- user explicitly requests a copy  -> requested new .pptx path
  -> replace-source rechecks source fingerprint
  -> atomic replace selected output path
```

- Writable scope in phase one is shape text and table-cell text; picture/chart/table containers can be
  inspected precisely but have no undefined generic mutation. The update command must not use the whole
  slide or similar text as a fallback. Multiple references of one source revision must be written as one
  batch into the same temporary PPTX, never overwriting output from the original file one by one and
  losing earlier edits.
- On fingerprint mismatch, missing slide/node, wrong type, out-of-range table coordinates, zero or
  multiple matches, fail closed and tell the user to reopen the preview and reselect; never continue
  writing.
- Fingerprint and OOXML location/copy must consume the same source byte snapshot; never hash and then
  reopen by path, or a concurrent replace separates the validated revision from the written revision.
- Before extracting any ZIP entry the resolver must run a centralized pre-check: compressed file at most
  `64MB`, non-directory entries at most `4000`, single entry uncompressed at most `32MB`, total
  uncompressed at most `256MB`, `ppt/media/` total at most `192MB`, single-entry compression ratio at most
  `200:1`. The first five align with the Preview Pane's current read limit and
  `RECOMMENDED_ZIP_LIMITS`; the ratio is the resolver's own boundary against high-ratio entries consuming
  Agent/Host resources.
- The resolver must reject duplicate entry names, absolute paths, backslashes, NUL, `.`/`..` path segments
  and encrypted entries; even though entries are never extracted to a directory, abnormal names break
  OOXML part location and repackaging consistency.
- Slide XML reads and archive repackaging must use fixed-size chunks and re-apply the per-entry/total
  limits on actual bytes read; loading media or embedded objects fully via `ZipFile.read()` is forbidden.
  Over-limit and abnormal ZIPs return the stable `pptx_update_failed` with `reason` `zip_limit_exceeded`
  or `invalid_zip_entry` and produce no output.
- Structured-reference edits from the Preview Pane overwrite the reference's `sourcePath` by default; a
  copy is written only when the user explicitly asks to "save as", keep the original or name a new `.pptx`
  path. This default belongs only to structured-reference edits and does not spread to ordinary PPTX
  creation, conversion, PDF export or a future native editor.
- Overwriting the source must use explicit `--replace-source`, a copy uses `--output <path>`; the two are
  mutually exclusive, and a missing output argument must never be silently read as a destructive overwrite.
  Both modes first write a same-directory temp file and finish ZIP/XML/target re-validation.
- Before the final atomic replace, `--replace-source` must re-read the source path and validate the
  original `sourceFingerprint`. If external PowerPoint/WPS or another Agent saved a new revision while the
  temp file was generated, the resolver must delete the temp file, fail closed and keep the current source;
  it must never overwrite newer content with a result based on an old revision.
- Overwrite mode creates no automatic backup or undo record; a user who wants to keep the original must ask
  for a copy explicitly. Execution on a remote workspace is carried by the existing Agent/Host workspace;
  no IO in the Renderer, relay or desktop main.
- OOXML write-back promises only the narrow text replacement above, not lossless PowerPoint editing,
  layout reflow, animation or collaboration semantics.

### Write-Back State Combinations and Pruning

| Case ID | Setup | Event | Expected result | Status |
| --- | --- | --- | --- | --- |
| PPTX-WRITE-01 | One or several same-revision structured element references | User states no save policy | One batch with `--replace-source`; atomic overwrite of `sourcePath` after temp-file validation | accepted |
| PPTX-WRITE-02 | Structured element reference | User explicitly asks to save as, keep original or name a new path | Write a new `.pptx` with `--output`; source unchanged | accepted |
| PPTX-WRITE-03 | Source changed after reference capture | Fingerprint mismatch when update starts | No trusted output; ask to reopen the preview and reselect | accepted |
| PPTX-WRITE-04 | Initial check passed, source saved externally while temp output was generated | Fingerprint changes again before replace-source commit | Delete temp output, keep the external new revision, return a stable conflict | accepted |
| PPTX-WRITE-05 | Same source revision contains several references | Model performs the edit | Only one `update-texts` batch; no one-by-one overwrite losing earlier edits | accepted |
| PPTX-WRITE-06 | Ordinary PPTX creation, conversion, PDF export or a future native editor | No Preview Pane structured reference | Does not inherit this overwrite default; follows its own artifact/save contract | pruned: separate product boundary |

## Data and Process Boundary

```text
PreviewPane
  -> workspace-scoped IFileService.stat(path)
  -> readFileRange(path, offset, length)
  -> Uint8Array
  -> PresentationPreviewEngine.open()
  -> preview DOM
```

- Path execution keeps using `workspacePath/path`.
- Workspace isolation keeps using `workspaceIdentity?.trim() || workspacePath`, and remote links keep
  `remoteSessionId`.
- Mobile `/remote` uses the file service of the Host already in the desktop window through shared-host
  attachment; no separate local/remote Host or Agent runtime.
- Document preview and unsent references do not enter the conversation task's continuous/replayable
  message flow; the structured prompt text after sending travels the existing conversation path with no
  new relay/main business state.
- `pptx-renderer` needs the full ArrayBuffer. Phase one reads in `256KB` segments with a `64MB` file
  limit; an old remote lacking `stat.size/readFileRange` falls back only to the existing
  `readMediaPreview` `8MB` compatibility channel. This version gap cannot be removed by the Renderer
  `stat`-ing again: an old Host returns no real size and has no range capability.
- A `readMediaPreview` over-limit error from an old remote must map to a PPTX-specific, localizable `8MB`
  compatibility-limit message, not reuse the `64MB` text and misreport the real threshold, and an absolute
  path returned by the service must not be shown to the user directly.
- Segmented reading must satisfy "actual bytes read equal the first `stat.size`"; an empty chunk, or a
  `stat.size` change in a second `stat` after reading, is treated as an incomplete file and a trimmed
  buffer must not be handed to the ZIP parser.

## Performance and Resource Management

- The PPTX React component and `@aiden0z/pptx-renderer` are lazy-loaded and stay out of the initial bundle
  of ordinary code/image preview.
- Parsing uses `RECOMMENDED_ZIP_LIMITS`, lazy slide and lazy media.
- The main preview mounts only the current page; page switch and unmount call the render handle's
  `dispose()`. Thumbnails mount near the viewport via IntersectionObserver and release slide handles when
  off-screen.
- A document switch or Pane unmount releases all image Blob URLs, chart instances and font resources.
- Document parsing and page rendering bind to the current viewer generation. After a switch or unmount,
  even if the old `open()` / render handle `ready` Promise completes or fails late, it may only release old
  resources and must not write the current viewer's document or load-error state.

```text
generation N             cleanup / data changed             generation N+1
open(N) ────────────────> invalidate N + dispose handles ──> open(N+1) -> render(N+1)
render(N).ready ── late reject ─────────────────────────────> generation mismatch -> ignore
open(N) ───────── late resolve ─────────────────────────────> dispose old document -> ignore
```

- `readFileRange` has no underlying abort protocol; after a document switch, check the effect's disposed
  state on every range RPC return, stop further segment reads and old-source state writes immediately.

## Errors and Logs

- File missing, the `64MB` general limit, the old-remote `8MB` compatibility limit, incomplete read, other
  read failures and parse failures each show a localizable read-only error.
- If another PPTX read error contains the current source file path, the user-visible text keeps only the
  filename; the full path may enter local logs only, so mobile `/remote` or a remote workspace never
  exposes server directories on the UI.
- UI logs go through `packages/ui/src/logger.ts`; never call `console.log` or `window.zcode?.log` directly.
  High-frequency per-node render info is not logged in production; phase one logs only one load/parse
  failure.

## Reserved Future Capabilities

- DOM editing: text, move, resize, delete, layering and undo/redo, with command state managed by
  `PresentationEditEngine`.
- The context floating bar implements only "AI 编辑" and shows no disabled or placeholder format controls.
  Only when the matching `PresentationEditEngine` mutation capability exists may a truly usable inline edit
  action join the same bar; `canSelect`, `canReference` and `canMutate` must stay separate.
- Export: `PresentationExportEngine` consumes a normalized Export DOM and outputs a new PPTX copy.
- Native Preview Pane save, if ever added, must add a workspace-scoped Host document service owning edit
  lease, source fingerprint, conflict check, temp file and atomic replace; `IFileService` is not extended
  to carry edit transactions.

## Verification

Automated checks:

- `.pptx` path recognition, source upgrade and size limit.
- The `.pptx` generic external-open button keeps the same display, disable and call semantics as XLSX and
  DOCX.
- Pure logic of paging, page-number clamp and zoom clamp.
- On consecutive document switches the old parse result is released and a late render error of an old page
  does not pollute the new document state.
- The watcher must be ready before the first PPTX read; closing the tab or switching source releases the
  subscription and calls `unwatch`.
- A target-file event triggers a re-read; events naming other paths in the directory are filtered; unknown
  path events stay compatible with old Hosts and reload conservatively.
- Consecutive watcher events use latest-wins generation; the success, failure and loading wrap-up of an old
  read cannot overwrite a new read.
- After a successful auto-reload, page, zoom, element selection mode, selected element and unconfirmed AI
  edit draft reset; Composer references are unchanged.
- Element model filtering, table-cell bounds, z-order hit-test, source generation cleanup.
- Reference payload validation, workspace/remote/scope isolation, exact de-duplication, prompt
  serialization and parse-back.
- Button/keyboard navigation of draft and history reference items, delete-button event isolation, same-file
  tab reuse and re-location on repeated requests.
- Leaving element selection before navigation; valid page location; independent feedback semantics for
  file missing, page missing and fingerprint change.
- Same-file page navigation does not re-read the PPTX; cross-file navigation still reuses the existing
  generation cleanup and late-result protection.
- A partial text selection keeps the full-element `textFingerprint`, `selectedText` enters the Composer
  context losslessly, and a shape/table-cell reference with a partial selection can still complete inspect
  and a full-text update.
- Resolver: fingerprint mismatch, node ambiguity/missing, shape text and table-cell updates, temp-file
  validation.
- `--replace-source` and `--output` are mutually exclusive; in-place overwrite succeeds; a source
  fingerprint change before commit keeps the external new revision; explicit save-as keeps the source.
- zh/en copy and UI font tokens; `pnpm typecheck`, `pnpm lint`.

Manual UI acceptance:

- Desktop local, SSH/WSL/Docker remote workspaces; mobile `/remote`; Zai Light / Zai Dark.
- Ordinary, chart, SmartArt, embedded fonts, large and corrupt files.
- Thumbnail selection, previous/next page, page jump, button and shortcut zoom.
- Selection mode and ordinary hyperlink clicks do not pollute each other; overlapping elements, table
  cells, page/file switch, adding/removing Composer chips.
- Clicking a concrete reference item from drafts and history user rows; repeated clicks on the same file;
  selection mode closed before locating; file-missing, page-missing and fingerprint-change toasts; the
  Preview Pane still expands when only the file can be located.
- Reference isolation between the Desktop main Composer and a non-focused split Composer, and the mobile
  `/remote` shared-host scenario.
- Visibility, disabled state, hint text and actual open result of the external-open button agree across
  PPTX, XLSX and DOCX.
- PowerPoint/WPS in-place save and temp-file rename save both trigger reload; consecutive saves finally
  show the last version.
- A deleted-then-recreated open file recovers; after closing the tab no Host watcher or file read fires.
