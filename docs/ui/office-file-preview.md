# Office File Preview

## Feature Summary

| Field            | Content                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Change           | Preview Pane has a read-only preview for Excel and Word (`.docx` / `.doc`)                                                 |
| User entry       | Workspace file tree, file links and other file-preview entries that produce a `CodeViewerSource`                           |
| Render libraries | `@extend-ai/react-xlsx@^0.16.0`, `docx-preview`; the legacy binary `.doc` compatibility path keeps `@extend-ai/react-docx` |
| State owner      | File bytes are read by the workspace-scoped `fileService`; parse and preview state are owned by the current Preview Pane   |
| Out of scope     | Office file editing, saving, export, password decryption, cross-device preview-state sync                                  |

## Document Content Security Boundary

Office files are untrusted content. No DOCX/XLSX/PPTX/legacy DOC/PDF renderer may hand a URL from the
document unchanged to the main renderer's DOM navigation or script execution path.

- External links allow only `http:` and `https:`; in-document links allow only validated `#anchor`.
- `javascript:`, `data:`, `vbscript:`, `file:`, `blob:`, control-character obfuscation and protocol-encoding
  variants must be rejected.
- After DOM generation the renderer still defensively scans `a[href]` / `a[xlink:href]` and watches
  asynchronously added nodes and attributes; the `href` of non-interactive resources such as images must
  not be removed by mistake.
- The DOM observer scans the whole preview root on first install; later mutations scan only the changed
  attribute target or the `addedNodes` subtree, and must not rescan the whole document when a third-party
  renderer mounts in batches or remounts due to virtualization.
- PDF preview currently forces `renderAnnotationLayer={false}`, so link annotations never enter the main
  renderer DOM; if the annotation layer is enabled in the future, the same link sanitization and
  controlled external-link callback must first be wired at the PDF mount point rather than relying on
  pdf.js default navigation.
- The third-party Office renderers have no unified relationship-interception interface, so the DOM gate is
  the mandatory choke point; if a parser later exposes a Target hook, it should reuse the same allowlist to
  reject up front.
- If a renderer later needs to keep in-document link interaction, it must live in a sandbox iframe with no
  preload, no Node and navigation/popups forbidden; the main renderer must not host third-party document
  scripts directly.
- Opening an external link goes through a controlled callback; an untrusted `href` is never passed directly
  to `window.zcode` or `shell.openExternal`.

Security regressions must cover the protocol allowlist, encoding/control-character bypasses, a real DOCX
hyperlink relationship, and manual acceptance of clicks in the Desktop main renderer; they must also lock
the PDF annotation layer off and verify that asynchronously added links sanitize only the changed subtree
without rescanning the whole preview root.

## Impact Brief

### UI Surface

| Item                  | Content                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| User scenario         | Open a Word / Excel file from the workspace                                                              |
| UI entry              | Workspace file tree, file links and other `CodeViewerSource` entries                                     |
| Shared implementation | `PreviewPane` -> `PreviewPaneContent` -> `PreviewPaneOfficeContent`                                      |
| Display / draft owner | The current Preview Pane's read, parse, zoom and error state; no persisted draft                         |
| Validation / gating   | Extension routing, 25 MB binary read limit, parser error boundary                                        |
| Commit                | Read-only call of workspace-scoped `fileService.readBinaryPreview`; no write commit                      |
| Authority             | File bytes at `source.path` in the current workspace                                                     |
| Mode boundary         | Desktop / Web / remote workspaces share service injection; preview state does not enter the message flow |
| Must isolate          | task/session, desktop continuous, web remote replayable, other preview tabs                              |

### Shared and Divergent Behavior

| Concern            | Shared                                                                              | Intentionally different                                                                                                | Meaning                                                                  |
| ------------------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| File read          | All Office types use the same bounded binary read and base64 RPC return             | none                                                                                                                   | No change to file service, workspace identity or the 25 MB limit         |
| Routing and errors | `PreviewPaneOfficeContent` lazy-loads, blank loading and localized error state      | `.xlsx`, `.docx`, `.doc` enter separate renderer chunks                                                                | `.docx` can swap implementation without affecting Excel or legacy `.doc` |
| Rendering          | All read-only Preview Pane content                                                  | `.docx` uses `docx-preview`; `.doc` uses legacy `react-docx`; Excel uses `react-xlsx`                                  | `docx-preview` cannot parse OLE `.doc`, so routing is explicit           |
| Excel multi-sheet  | One read-only controller per workbook                                               | ZCode's custom sheet navigation shows only visible workbook tabs and does not enable the library's edit/export toolbar | Sheet switching must not cost re-parsing or opening write capability     |
| DOCX pagination    | Pages keep OOXML section boundaries and their own margins                           | Uses the official `docx-preview` default section grouping; `lastRenderedPageBreak` is not additionally enabled         | Same-size sections may still have different margins and must not merge   |
| Responsive         | Word preview shares the shrink-only-never-enlarge rule of `calculateDocxPreviewFit` | DOCX measures the generated HTML wrapper; legacy `.doc` measures the editor canvas                                     | Keeps desktop narrow sidebar and small-screen layout semantics           |
| Lifecycle          | Source switch clears the currently visible content                                  | DOCX `renderAsync` has no cancel API, so detached DOM + active guard                                                   | An old async result cannot overwrite the latest file                     |

### Feature Relationships

| Rank           | From                            | Edge                      | To                                         | Condition / reason                                                            |
| -------------- | ------------------------------- | ------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| must-inspect   | Office file preview             | renders-in                | Preview Pane Office surface                | The only user-visible entry (`PreviewPane.tsx`, `previewPaneContent.tsx`)     |
| must-inspect   | Preview Pane Office surface     | reads-through             | workspace binary preview service           | Office parsing needs full bounded bytes (`PreviewPane.tsx`, `fileService.ts`) |
| must-inspect   | DOCX surface                    | renders-with              | `docx-preview.renderAsync`                 | `.docx` only (`previewPaneOfficeDocxContent.tsx`)                             |
| conditional    | legacy Word surface             | renders-with              | `@extend-ai/react-docx`                    | OLE `.doc` compatibility path only (`previewPaneOfficeLegacyDocContent.tsx`)  |
| invariant-only | Preview Pane local render state | must-remain-isolated-from | desktop continuous / web remote replayable | Preview is not task runtime or recovery state                                 |

### State Owners and Commit Sinks

| State / fact                            | Display owner                  | Authoritative owner                | Command / service          | Persistence |
| --------------------------------------- | ------------------------------ | ---------------------------------- | -------------------------- | ----------- |
| Office file bytes                       | `PreviewPane`                  | Current workspace file service     | `readBinaryPreview`        | none added  |
| DOCX generated DOM, loading, error, fit | `PreviewPaneOfficeDocxContent` | The currently mounted Preview Pane | `docx-preview.renderAsync` | none        |
| File type                               | `getOfficeFilePreviewKind`     | source path extension              | no commit                  | none        |

### Must-Preserve Invariants

| Invariant                                                                                               | Surface / mode                             | Proof                                                                          |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------ |
| `.docx` no longer enters `@extend-ai/react-docx`; `.doc` does not enter `docx-preview`                  | Desktop / Web / local / remote             | Routing helper and two separate lazy chunk unit tests, production build output |
| After a source switch, an old `renderAsync` result cannot commit to visible DOM                         | All DOCX previews                          | stale render component test                                                    |
| Adjacent same-size sections render as independent pages with their own `pgMar`                          | All DOCX previews                          | Real two-section fixture + renderer regression test                            |
| DOCX white pages use a low-contrast light shadow, not the renderer's default 50% black shadow           | light / dark / Zai Light / Zai Dark        | page surface style component test + CDP computed style                         |
| Preview never reads a same-path local file in place of a remote workspace file                          | SSH / WSL / Docker / Web                   | Existing workspace service wiring reused                                       |
| Preview state does not enter the task/session snapshot or message flow                                  | desktop continuous / web remote replayable | No protocol, store, main or relay change                                       |
| Document content keeps white paper and its own colors; the outer chrome uses only semantic theme tokens | light / dark                               | runtime screenshot + `DESIGN.md` check                                         |

The feature graph `.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml` carries the
Office file preview capability, surface, local render owner and binary preview service nodes and edges.
No unresolved questions: the user fixed the `.docx` renderer target; keeping `.doc` is a compatibility
decision from the new library's format boundary and the existing product contract. E2E handoff is not
needed (no conversation/session; component + Web runtime + production build suffice).

## Boundary Decisions

| Boundary          | Decision                                                                                                                                                                                                                                                                                                                 | Reason                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Excel extensions  | Support `.xlsx`, `.xlsm`, `.xls`; `.xlsx` is the fully supported path, `.xlsm` / `.xls` show what the library's limited parsing can read                                                                                                                                                                                 | `react-xlsx` officially supports mainly OOXML `.xlsx`; old formats show only data the underlying parser can read                                               |
| Word extensions   | OOXML `.docx` uses the stable `renderAsync` API of `docx-preview`; legacy binary `.doc` keeps the read-only editor viewer of `@extend-ai/react-docx`                                                                                                                                                                     | `docx-preview` targets ZIP/OOXML DOCX and cannot parse OLE `.doc`; splitting replaces the problematic DOCX chain without regressing `.doc`                     |
| Interaction       | Read-only throughout; no editing, saving, copy-paste or export capability                                                                                                                                                                                                                                                | Preview Pane shows content and owns no file-write semantics                                                                                                    |
| File source       | Keep resolving the workspace-scoped `fileService` from the source's `workspacePath`, `workspaceIdentity`, `workspaceRemoteSessionId`                                                                                                                                                                                     | Local, SSH / WSL / Docker, standalone Web and mobile remote share one service boundary                                                                         |
| File read         | A new generic bounded binary preview read returns the whole file as base64 over RPC; limit 25 MB                                                                                                                                                                                                                         | Office ZIP / OLE parsing needs full bytes; avoids UI direct Node file access and unbounded cross-process transfer                                              |
| Loading           | Office render components and third-party libs lazy-load by file type; Excel WASM loads as a build asset                                                                                                                                                                                                                  | Keeps ordinary text/image preview free of Office parser size and init cost                                                                                     |
| Loading feedback  | During file read, lazy load and parse keep a blank preview surface with only an invisible `aria-busy` state; do not show an "Office file preview loading" text                                                                                                                                                           | Real loading is short, and flashing text causes needless visual jumps                                                                                          |
| Theme             | Excel receives the current light/dark theme; DOCX keeps paper white and neutral page gaps, dark theme changes only the outer workspace                                                                                                                                                                                   | Document colors are content semantics and must not be rewritten by the app theme                                                                               |
| Excel multi-sheet | Keep `showDefaultToolbar={false}`; render only visible workbook tabs through the `toolbar` render prop; selecting a tab calls `setActiveTabIndex` on the same controller                                                                                                                                                 | The default toolbar carries both sheet tabs and edit/download actions; preview needs only multi-sheet navigation without reopening write or export entries     |
| Excel ZIP paths   | Accept `.xlsx` whose ZIP entries use non-standard Windows backslash separators, normalized by `react-xlsx@0.16.0` at the unified read boundary before parsing                                                                                                                                                            | Some Excel writers produce entries like `xl\worksheets\sheet1.xml`; older versions misreported recoverable files as missing required parts                     |
| Page layer        | DOCX pages reuse the old `react-docx` light paper shadow `0 2px 10px rgba(15, 23, 42, 0.08), 0 1px 2px rgba(15, 23, 42, 0.05)`, overriding the `docx-preview` default 50% black shadow                                                                                                                                   | Paper is an ordinary content surface, not an overlay; a low-contrast shadow separates page from background without a heavy black edge                          |
| Responsive        | The preview root fills the Preview Pane; Excel scrolls inside its own container; DOCX measures the generated page wrapper after `renderAsync`, scales proportionally down to the available container width when too narrow, recomputes live when the container widens, never enlarging beyond the original document size | Desktop and mobile Web share semantics while original paper pixel width cannot break the Preview Pane                                                          |
| DOCX pagination   | `ignoreLastRenderedPageBreak` stays at the `docx-preview` official default `true`; adjacent sections, even of the same paper size, generate separate pages applying their own `pgMar`                                                                                                                                    | With `false`, `docx-preview@0.4.0` merges same-size sections without an explicit page break, so body text inherits the cover's zero margins                    |
| DOCX security     | Disable `altChunk` HTML rendering; images and fonts use base64 URLs; discard stale render results and clear generated DOM on file switch or unmount                                                                                                                                                                      | The preview file may come from an untrusted workspace; avoids injecting embedded HTML into the renderer and an old async document overwriting the current file |
| Errors            | A missing file keeps the existing weak hint; over-limit, parse failure and corrupt format show a localized error state and log once through the UI logger                                                                                                                                                                | Keeps the existing Preview Pane error hierarchy and gives diagnosable evidence                                                                                 |

## Domain Scope

| Domain                               | Included | Note                                                                                                |
| ------------------------------------ | -------- | --------------------------------------------------------------------------------------------------- |
| File / workspace service             | Yes      | Binary files are read through the dependency-injected workspace service                             |
| UI shell / theme / responsive / i18n | Yes      | New render container, loading and error states, zh/en copy                                          |
| Rendering / performance              | Yes      | Office dependencies and parsing load on demand; transfer protected by the 25 MB limit               |
| Workspace identity / remote runtime  | Yes      | Isolation keeps using `workspaceIdentity?.trim() \|\| workspacePath`; file path is only for reading |
| Session / task realtime              | No       | Preview is UI-local state, not in continuous or replayable message flows                            |
| Persistence                          | No       | Page, sheet, zoom or Office document state is not saved                                             |

## Candidate Combinations

| ID     | File / environment                                        | Action                  | Expected result                                                                                                  | Status                                |
| ------ | --------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| OFP-01 | Local `.xlsx`                                             | Open from file tree     | Read full bytes, show a read-only workbook, sheets switchable                                                    | accepted                              |
| OFP-02 | Local `.docx`                                             | Open from file tree     | Show a read-only paginated document via `docx-preview.renderAsync`                                               | accepted                              |
| OFP-03 | `.xlsm` / `.xls`                                          | Open from file tree     | Try to show data the underlying parser supports; failure enters the unified error state                          | accepted                              |
| OFP-04 | SSH / WSL / Docker / Web workspace                        | Open an Office file     | Use the matching workspace-scoped `fileService`, never the same-path local file                                  | accepted                              |
| OFP-05 | Phone narrow screen or narrow desktop Preview Pane        | Open an Office file     | DOCX pages scale proportionally to available width with no horizontal overflow, last page reachable by scrolling | accepted                              |
| OFP-06 | File over 25 MB                                           | Open                    | Refuse the cross-RPC read and show a localized over-limit error                                                  | accepted                              |
| OFP-07 | Corrupt, encrypted or parser-unsupported file             | Open                    | Show a localized cannot-preview error, other tabs unaffected                                                     | accepted                              |
| OFP-08 | Plain text, Markdown, SVG, image                          | Open                    | Original rendering and menu behavior kept                                                                        | accepted                              |
| OFP-09 | Legacy binary `.doc`                                      | Open from file tree     | Read full bytes and show a paginated document through the Word read-only chain                                   | accepted                              |
| OFP-10 | Office file edit/save                                     | Operate in Preview Pane | Capability not provided                                                                                          | pruned: beyond read-only preview duty |
| OFP-11 | Any supported Office file                                 | Open preview            | Blank during loading, no visible loading text flash; content shows directly when done                            | accepted                              |
| OFP-12 | Two-section DOCX with zero-margin cover and margined body | Open preview            | Two independent pages; body keeps its own left/right margins, not merged with the cover section                  | accepted                              |
| OFP-13 | `.xlsx` with backslash ZIP entries                        | Open preview            | Normalize entry paths and show the workbook, no corrupt-file error                                               | accepted                              |

## Accepted Cases

| Case ID | Setup                                                       | Action                         | Assertions                                                                                                                                                       | Evidence                                                         | Automation |
| ------- | ----------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------- |
| OFP-01  | Small multi-sheet `.xlsx`                                   | Open preview and switch sheet  | Recognized as Excel; binary read called; all visible sheet names shown; selection calls `setActiveTabIndex` and updates the active sheet; no edit/export toolbar | UI helper + component interaction test + CDP runtime             | covered    |
| OFP-02  | `.docx` with paragraphs                                     | Open preview                   | Recognized as DOCX; binary read called; `docx-preview.renderAsync` called with safe options                                                                      | UI helper + component test + CDP runtime                         | covered    |
| OFP-04  | Source with remote workspace params                         | Open preview                   | Workspace triple still passed to `useWorkspaceServices`                                                                                                          | Existing Preview Pane wiring + regression test                   | covered    |
| OFP-05  | DOCX original paper width larger than the preview container | Open, resize, scroll to bottom | Scale is `min(1, available width / original width)`; wrapper size and transform use the same ratio; no horizontal overflow and last page reachable               | component test + CDP scaled-scroll regression                    | covered    |
| OFP-06  | Binary file over 25 MB                                      | Read preview                   | Service rejects before reading, returns no content                                                                                                               | service unit test                                                | covered    |
| OFP-07  | Invalid Office bytes                                        | Render preview                 | Parser error converted to a readable error state by the error boundary                                                                                           | component test                                                   | covered    |
| OFP-08  | Existing text / image source                                | Open preview                   | Still takes the existing chunked text or media path                                                                                                              | existing tests                                                   | covered    |
| OFP-09  | OLE Compound Document `.doc`                                | Open preview                   | Recognized as legacy Word; binary read called; handed to `react-docx` only on this compatibility path                                                            | UI helper + PreviewPane routing test + real parser/runtime smoke | covered    |
| OFP-11  | Office file read or parse unfinished                        | Open preview                   | Blank preview surface with `aria-busy`, no visible loading text                                                                                                  | component test                                                   | covered    |
| OFP-12  | Two same-size sections with different margins               | Open preview                   | `docx-preview` generates two `section`s; the second page uses the body `pgMar`, not the cover's `padding: 0`                                                     | real DOCX renderer regression + CDP runtime                      | covered    |
| OFP-13  | Required OOXML part with backslash ZIP entry                | Open preview                   | `react-xlsx` controller finishes parsing, no `Missing required part` error and a worksheet tab is generated                                                      | real renderer integration test                                   | covered    |

## Implementation Contract

- `packages/shared` declares the generic binary preview return type; `IFileService` exposes a size-bounded
  read method.
- `packages/services` checks the size after `stat` and before `readFile`; default and hard limit are both
  25 MB.
- `packages/ui/src/PreviewPane.tsx` only does recognition, read lifecycle and error normalization; Office
  rendering lives in separate modules.
- Office files must not first enter the binary fallback of `readTextFile`; results of an old request must
  be dropped on a source switch.
- Third-party renderers must load dynamically. The Excel viewer must be explicitly `readOnly` and WASM must
  come as a relative build asset usable by Vite / Electron.
- The Excel renderer must use `@extend-ai/react-xlsx@^0.16.0` or a higher compatible version so
  non-standard backslash ZIP entries are normalized at the read boundary shared by worker, main thread and
  deferred load.
- Excel must keep `showDefaultToolbar={false}` so no edit, save or export entry opens; multi-sheet
  navigation must read `controller.tabs` through the `toolbar` render prop and switch with
  `controller.setActiveTabIndex` inside the same workbook controller; it must not show only the first
  sheet nor rebuild or re-parse the workbook to switch.
- `.docx` and `.doc` must keep bypassing `readTextFile` and get full bytes through the bounded binary read
  interface; they must not fall back to code preview because a `.doc` may contain extractable text.
- `.docx` must call `docx-preview.renderAsync` and never re-enter the model/editor chain of
  `@extend-ai/react-docx`. Render options must disable `renderAltChunks`, disable debug and use base64 URLs;
  only the current source's async result may commit to visible DOM.
- `.docx` must not override `ignoreLastRenderedPageBreak` to `false`; the official default section grouping
  is kept so same-size sections still paginate independently and apply their own margins.
- Pages generated by `docx-preview` must override its default `0 0 10px rgba(0, 0, 0, 0.5)` shadow with the
  old `react-docx` light paper shadow; white pages must not switch back to a dark shadow by the app dark
  theme.
- Legacy binary `.doc` keeps its separate `useDocxEditor` + `DocxEditorViewer mode="read-only"`
  compatibility path; that path must not be reused for `.docx`.
- DOCX must keep the document's original layout ratio and shrink only when the generated page width exceeds
  the container's available width; the scaled placeholder width/height must update in sync, not leave an
  unscaled scroll area behind a bare `transform`.
- The Office loading phase shows no visible loading text; the blank state is still exposed to assistive
  technology via `aria-busy`.
- New styles use only `DESIGN.md` semantic tokens and are verified in Zai Light, Zai Dark and narrow
  screens. UI error logs use `packages/ui/src/logger.ts`, never `console`.

## Verification

- Service unit: normal base64, default/custom size limit, directory rejection.
- UI unit: extension recognition, Excel multi-sheet names and switching interaction, Excel default edit
  toolbar off, real Excel parsing of backslash ZIP entries, `.docx` / `.doc` routing, no code-wrap menu for
  Office files, loading and error branches, `renderAsync` safe options, same-size two-section pagination and
  margins, DOCX light page shadow, legacy `.doc` read-only props.
- Desktop runtime: open a real multi-sheet `.xlsx`; all sheet tabs visible, clicking switches the active
  sheet content with no re-read of the file.
- Web runtime: open the official `docx-preview` `page-layout` DOCX fixture; the 794px original paper scales
  to `0.531486` in a 422px Preview Pane, no alert in the visible DOM, no browser page error.
- Build smoke: Desktop renderer and Web production builds both resolve the Office packages, worker and
  Excel WASM assets.
- Repository gates: `pnpm typecheck`, `pnpm lint`.
