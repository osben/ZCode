# Right-Pane Image Preview Actions

## Download and Add to Chat (2026-10-14)

User-confirmed: "Add to chat" follows the file tree's file-reference approach, adds to the current input
and never sends automatically. Covered: empty draft, existing draft and workspace isolation; send, queue,
fork and rewind state combinations are out of scope.

1. The image-area context menu offers "添加到聊天" (Add to chat), "复制图片" (Copy image) and "下载图片"
   (Download image). On narrow screens the same menu opens from an "图片操作" (Image actions) button, not
   relying on right-click or side-by-side buttons.
2. Download reuses the fullscreen image preview's bounded download and `IPlatformService.saveFile`:
   desktop uses Save As (cancel shows no error), Web uses a browser download. Original bytes and image
   format (PNG/JPEG/WebP/SVG etc.) are saved; SVG is never downloaded as a screenshot, and the existing
   copy-as-PNG semantics are unchanged.
3. Native save success shows only "下载成功" (Download complete) without a file path; the fullscreen
   image preview uses the same short notice. If the browser has not confirmed the write yet, "图片下载已开始"
   (Image download started) is shown; cancelling shows nothing.
4. Add to chat reuses `dispatchWorkspaceFileAddToChat`: the focused Composer appends a file mention and
   focuses; existing text and attachments are kept, with no user message, upload or Agent request.
5. A file reference needs a real source path and workspacePath. A relative reference is generated only
   when the image path is actually inside the source workspace; an image outside the workspace keeps its
   absolute path even if a same-named file exists inside. A local file in an unbound or different local
   workspace's draft uses an absolute reference. With a remote Host, `workspaceIdentity?.trim() ||
   workspacePath` must match; with a different remote identity or no source path, the reference entry is
   disabled and a remote path is never inserted as a local path.
6. Download extensions cover the preview-supported PNG/JPEG/APNG/AVIF/BMP/GIF/ICO/SVG/WebP. With an
   unknown MIME, the image extension of a trusted source filename is kept; a known MIME takes priority so
   extension and format agree.
7. An SVG with a source path is downloaded by a bounded read of the original bytes through the matched
   source workspace's file service at click time, never from the re-encoded data URL of the text preview.
   Only an inline SVG with no source file downloads the current inline content.
8. PreviewPane reads content along the existing source scope; the reference only changes the current
   Composer's renderer draft and does not change `remoteSessionId`, shared-host attachment or
   continuous/replayable recovery semantics.
9. While the image is not loaded or a current image action is unfinished, copy/download are disabled;
   with no Composer able to receive, adding a reference shows an explicit failure.

```text
file SVG path -> source workspace fileService original-byte read ─┐
other image / inline SVG original bytes ──────────────────────────┴-> shared bounded download -> Desktop saveFile / Web download
current image path + workspaceKey -> match focused Composer -> existing file reference event
                                                   └─ append to draft, do not send
```

Acceptance: PIA01 original-format download and cancel (incl. APNG/BMP/ICO extension and original-byte
comparison, and non-UTF-8 SVG with an ISO-8859-1 declaration); PIA02 file reference and attachment
retention for empty/existing drafts; PIA03 same path with different workspace identity is refused (incl.
same-named images inside/outside the workspace, where the canonical mention after the reference event
keeps the outside image's absolute path); PIA04 menu reachable at phone width, zh/en, both themes. The
desktop candidate and folder fixture stay in `conversation-session/manual-review/pending`; physical
phones, real SSH/WSL/Docker and Windows/Linux native Save As are not run and must be flagged.

## Behavior (Copy)

- Plain images and rendered SVGs in the right preview offer a "复制图片" (Copy image) context menu.
- A focusable desktop preview area uses a keyboard menu; narrow screens show a text-labeled "图片操作"
  menu button so the mouse right-click is not required.
- Copy writes to the current client's system clipboard as PNG, preserving natural size and transparency;
  SVG, JPEG etc. are rasterized first. The copied content is the image, not a path, source or a
  checkerboard screenshot.
- The entry is disabled until the image loads and while a copy runs. Completion shows a success notice;
  decode, clipboard permission or missing API shows an explicit failure, never a false success.
- Existing menu, button, toast, theme tokens and zh/en translations are reused; preview layout, Retina
  rules and SVG source toggle are unchanged.

## Boundary and Timing

```text
current preview image -> user right-click/button -> immediately submit ClipboardItem(Promise<PNG>)
                                  └─ current img natural pixels -> canvas -> PNG
system clipboard write done -> success notice; any rejection -> failure notice
```

The PNG conversion promise must be created and submitted immediately inside the user action, so async
conversion does not consume Safari's user activation. The component owns only this copy's pending state;
no service-layer or main-process business state is added.

Remote files keep the existing file read and preview data chain, and the copy happens on the client
viewing the image; no Agent request, no change to workspaceIdentity, desktop continuous or web remote
replayable recovery boundaries. Not extended to the fullscreen session image gallery.

## Verification Cases

| ID     | Precondition and action                  | Assertion                                          |
| ------ | ---------------------------------------- | -------------------------------------------------- |
| PIC-01 | Right-click copy after PNG loads         | Native clipboard holds an image, pixel size equals the original |
| PIC-02 | Right-click copy after SVG preview       | Native clipboard holds PNG, pasteable as an image  |
| PIC-03 | Narrow screen, open image actions, copy  | Same path as right-click, no horizontal overflow   |
| PIC-04 | Loading, decode failure or clipboard rejection | Entry disabled or explicit failure, no success shown |
| PIC-05 | Light/dark theme, zh/en, keyboard menu   | Text visible, menu operable, preview layout unchanged |

E2E candidate: `packages/desktop/test/e2e/manual-review/pending/preview-pane-image-copy.test.ts` (goes only
through the file tree and image preview, no session state change; stays pending until manual review). It
starts from the common replay fixture and produces no model requests:

```sh
ZCODE_E2E_MANUAL_REVIEW=1 \
E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json \
pnpm --filter @zcode/desktop test:e2e -- \
  --spec './test/e2e/manual-review/pending/preview-pane-image-copy.test.ts'
```

## Verification Outcome (2026-10-14)

- Copy: macOS Electron opened SVG/PNG from the real workspace file tree, right-click copy, native
  clipboard size and keyboard Shift+F10 menu verified; Chrome at 390x844 touch viewport passed in both
  themes and zh/en; clipboard rejection shows only the failure notice. Emulated viewport is not real
  device or remote-host evidence.
- Download and reference: macOS desktop `conversation-session-preview-image-actions` 2/2 (PNG/APNG/BMP/ICO,
  UTF-8/ISO-8859-1 SVG saved bytes and default file names, cancel, empty/non-empty draft, focus,
  attachment retention, zero model requests); browser 9/9 (390/1100px x Light/Dark x zh/en plus the
  outside-workspace same-name absolute reference chain). Review findings CR-01/02/03 (external image
  keeps absolute reference, correct extensions, file SVG downloads original bytes through the source file
  service) were fixed with regressions.
- Native Save As now shows only the short success notice without a path, verified in a standalone Electron
  window.
- Root typecheck, desktop `typecheck:e2e`, lint, architecture and candidate fixture checks passed
  (existing lint warnings only). Not verified: Windows/Linux native Save As, physical mobile Safari, real
  remote Host. No Docker admission is claimed.
