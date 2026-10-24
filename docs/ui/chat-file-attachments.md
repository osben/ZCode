# Chat File Attachments (current state)

Attachments are managed by the V4 composer. After the user selects, pastes or drags in an attachment it is pre-uploaded immediately; only a `ready` attachment that has obtained an `AttachmentRef` can be submitted with `sendText.attachments`.

Send admission uniformly requires "body or attachment, at least one": `text.trim()` is non-empty, or at least one valid `AttachmentRef` exists. An attachment-only draft, idle send, running queue and query edit are all legal input; when body and attachments are both empty the result is `proto.invalidPayload`.

## State and gating

```text
waitingSession -> queued -> uploading -> committing -> ready
                              |
                              +-> transient failure -> auto-retry once after 500ms
                              +-> failed -----------> user retries manually
```

The Renderer keeps upload state by `workspaceKey + composer scope`; `workspaceKey` is uniformly `workspaceIdentity?.trim() || workspacePath`. This state does not enter relay/main and the browser `File` is not persisted, but after a task switch or a local composer unmount the current upload can be restored and continued.

- Upload concurrency is capped at 2; progress is monotonic, capped at 99% before commit, and 100% is shown for about 300ms after a successful commit.
- While any attachment is not `ready`, the send button and both held-queue choice buttons are disabled; the submit entry validates again and must not produce `sendText` or any queue command.
- Automatic retry happens at most once; a manual retry starts a new retry budget. A successful upload does not send automatically.
- Deleting an attachment aborts the in-flight transaction and cleans staged content. A CLI/runtime generation change invalidates uncommitted refs and re-uploads them with the original retry budget.
- The cleanup above applies only to uncommitted composer attachments. When editing an already-sent query, deleting an attachment only updates the reference list of the new active branch and does not delete the local files, artifacts or remote staged content used by the old branch.
- Attachment drafts and upload state are isolated by `workspaceKey + composer scope`; switching task does not cancel a background upload, and it keeps showing after switching back.

## Transfer routing

```text
local desktop localPath ---------------------------> ready (zero copy)
SSH/WSL/Docker localPath -> host transfer -> remote stage -> ready
Web/inline bytes --------> V4 begin/chunk/commit ---------> ready
```

- A real local desktop path does not fake upload progress.
- Web/inline uses the existing V4 chunk transaction with an unchanged wire schema; the high-level put provides progress and cancel.
- For SSH/WSL/Docker the desktop host transfers the host-local path to a staging path the remote runtime can read; a desktop path must never be handed straight to the remote Agent.
- Relay and desktop main only pass RPC through and keep no attachment draft, progress, queue or session business state.

## Derived path for pasted images

Clipboard images keep the session-scoped data URL artifact as the persisted fact. After the artifact commit the CLI eagerly materializes a real image file in a separate session-scoped image cache directory; this file is only a rebuildable derived cache and is not written into `AttachmentRef`, the conversation transcript or the replayable snapshot.

```text
<storageRoot>/cli/
  |- artifacts/<sessionId>/...                              # durable artifact
  `- image-cache/<sessionId>/image-<artifact-uri-hash>.<ext> # derived image
```

This section defines only the path isolation between the derived image and the durable artifact; no periodic cleanup or old-path migration semantics are added.

```text
paste -> durable data URL artifact -> eager image file
send  -> ensure image file path
          |- being written: wait for the same task
          |- exists: reuse
          `- missing: rebuild once from the durable artifact
```

The URI singleflight lifecycle is independent of a single query and takes no caller-owned `AbortSignal`. Paste and send reuse and await the same materialization Promise directly, so one request's cancellation does not propagate to the shared cache task.

## Composer PDF attachments

PDF is a distinct prompt attachment type but reuses the admission, artifact, FilePart, derived cache, recovery and pre-request capability projection boundaries of image/video. In the UI a PDF stays a document file card and does not enter the image media grid; both the composer draft and the sent user row can open the existing PdfViewer.

```text
local/staged path or V4 upload bytes
  -> TurnAttachment(type=pdf)
  -> validate MIME, 20MiB limit and %PDF magic
  -> durable zcode-artifact:// URI
  -> FilePart link + metadata in part.data
  -> <storageRoot>/cli/pdf-cache/<sessionId>/pdf-<uri-hash>.pdf
  -> materialize the path before the request, then omit/restore by supportsPdf
```

- Web/inline PDF keeps the V4 20MiB limit, 512KiB chunks and the existing upload transaction; a Desktop local/staged PDF is not inlined as base64 in the renderer and is read by the Agent with a bound at admission.
- The artifact is the attachment's source of fact; `part.data` stores no base64 or cache path, and `pdf-cache` is a rebuildable derived file that does not enter the transcript, snapshot or replayable events.
- The current live turn may reuse a local/staged path accessible to the runtime; cold recovery, historical messages and model switches must prefer `artifact -> pdf-cache`, and an old local path must not override artifact content.
- A sent-PDF preview is authorized by exact session/row/part and reads in slices through `attachment/read` with offset/limit; when the artifact exists but materialization fails it degrades only to artifact chunks and never falls back to the mutable original path.
- `supportsPdf=true` keeps the PDF file block and `[PDF: source: <path>]`; `supportsPdf=false` omits only the provider-visible PDF data and keeps the source text. Every request is re-projected and persisted history is not modified.
- No attachment DB table is added. An existing `application/pdf` FilePart is hydrated directly; a historical attachment with only an old local path tries to re-artifactize before the request, and when the source file is gone an explicit unavailable source text is kept; decoding it as a UTF-8 ordinary file is forbidden.

The final provider request appends plain text `[Image: source: <absolute-path>]` in the same real user content: a model that supports images receives the image block and the path; only when `supportsImages === false` explicitly is the image block replaced by the existing media-omitted text, with the path kept. The path does not go through system reminders, runtime attachments or MCS. For multiple images all image/omitted blocks come first and all available path blocks after. An image with an existing real local path reuses the original path and creates no derived copy. If the derived cache does not support an image MIME it is best effort: the original image/base64 provider chain is kept and only that image's cache/path is skipped; a real IO or durable artifact fault for a supported MIME still fails explicitly before the provider call.

## UI

- Images keep a compact thumbnail with a circular progress ring and percentage in the center.
- Non-image attachments show an equivalent text status; the failed state offers retry and delete.
- State does not depend on color alone; localized `aria-label` / `role=status|alert` are required.
- An inline image/video/PDF over the size limit (image 20MiB) is a deterministic failure: no automatic retry, the chip goes to failed directly and sending stays disabled; the failure reason uses the existing tooltip/aria surface and shows the localized `chat.attachments.oversizedInline{Image,Video,Pdf}` (with file name, actual size and limit); the error code `oversized-inline-*-attachment` must never be shown.
- File drop in V4 is taken over solely by the root node of the whole conversation pane: timeline, empty state, status area and composer are all one drop surface; the main input no longer registers a file drop itself. The lightweight title bar of the desktop new task shows a temporary drop mask once the window-level drag state is active and connects it to the main draft composer. This structure matches the old `ChatView`.
- `WORKSPACE_FILE_DRAG_MIME` from the workspace file tree is not uploaded as an attachment but inserts a workspace file mention; only operating-system files enter the attachment pre-upload queue. This matches the old `ChatView`.
- Mobile Web has no system file drag/picker entry; it only reuses the V4 composer's renderer-local drop routing and adds no runtime, host, relay or `web-remote-replayable` transfer semantics.
- The inline editor of a sent query may only delete existing attachments; it offers no file picking, dragging in, paste-to-attachment or re-upload. Ordinary composer paste of 5120 characters still converts to a text attachment per the existing rule; an equally long text pasted in inline edit stays as the `editUserQuery.newText` body.
- When cells are copied from Excel or spreadsheet software the system clipboard may expose `text/plain`, Excel HTML and a synthetic `image/png` together. The ordinary composer must prefer text when it detects Excel HTML markers or tab-separated text: short content goes to the editor paste, and only at 5120 characters does it convert to a clipboard-text attachment; the synthetic PNG of the same payload must not be treated as an image the user actively pasted. Screenshots, image copies and `.xlsx` files without spreadsheet text evidence still go through attachments.

## Attachment editing of a sent query

```text
row.attachments
  -> copied into renderer-local editAttachments when edit opens
       -> delete one or more refs
          -> accepted: editUserQuery.attachments replaces the active branch as given
          -> failed/stale/blocked: keep local edit state
          -> cancel: discard local state, re-initialize from the row next time
```

Three-state contract of `editUserQuery.attachments`: an absent field keeps the canonical original attachments; a non-empty array replaces them in the given order; an explicit `[]` clears all attachments. Deleting a sent attachment calls no attachment transfer, abort or cleanup API, so old history and references of other branches are not broken.

## Sent image preview

A sent user row still stores only `AttachmentRef`. Image attachments (`mime` starting with `image/`) are clickable; non-image attachments stay static, with no button, hand cursor or keyboard-open semantics. The renderer does not treat the pre-send `File`, object URL or base64 as historical fact; live, cold resume and app restart all use the same read-only query from the current row ref.

```text
ConversationRow.userInput.attachments
  -> image click
     -> workspace service (following the current workspaceIdentity / remoteSessionId attachment)
        -> v4/attachment/read(sessionId, previewRef ?? ref, offset, limit)
           -> CLI first verifies the ref belongs to an image row of the current session
              -> zcode-artifact:// ref: read the persisted artifact
              -> local / SSH / WSL / Docker path: read by the runtime hosting that session
           -> <= 512 KiB decoded chunk, returned as base64 in NDJSON
        -> renderer assembles a Blob URL -> image preview dialog
        -> close / target change / unmount -> URL.revokeObjectURL
```

```text
desktop-continuous row -------------------+
                                          +-> the same read-only attachment/read query
web-remote-replayable row -> attached host+

relay / desktop main: forward only, keep no bytes, cache, row or preview state
```

- The query must carry the exact `sessionId`, and the CLI accepts only the `ref` or `previewRef` of an image attachment in that session's current projection; an arbitrary renderer path must never become a file-read interface.
- The wire returns at most 512 KiB decoded bytes at a time; the UI high-level transport pulls until done by `nextOffset`, so a 20MiB attachment does not exceed the 1MiB NDJSON envelope. The CLI may keep a short, bounded same-ref read cache but must not persist it to relay/main or put it into the conversation snapshot/event.
- On read failure the dialog shows a localized "image cannot be previewed" (图片不可预览), keeps the file name to explain the history, and the card then loses its open semantics and fake hand cursor. A failure does not modify the row, branch, provider context or attachment file.
- Mobile `/remote` adds no separate Agent runtime; it reaches the local/remote workspace session host already present in the desktop window through shared-host attachment. Remote identity isolation still uses `workspaceIdentity?.trim() || workspacePath`, and path execution still uses `workspacePath`/the runtime ref.
- When old history has no readable ref, the file was moved/deleted or the artifact was reclaimed, no path is guessed and base64 is not stuffed back into the row; it explicitly enters the non-previewable state.

```text
file dragged onto pane / desktop draft title bar
  -> the target SessionPane's ConversationComposer drop controller
       -> workspace-file MIME -> insert mention
       -> OS File[]           -> attachment pre-upload (original V4 route)

the main input registers no drop of its own
  -> the same event is consumed once, by the outer SessionPane
```

Implementation entries: `packages/ui/src/v4/ConversationComposer.tsx` and `packages/ui/src/v4/composer/useComposerAttachments.ts`.
