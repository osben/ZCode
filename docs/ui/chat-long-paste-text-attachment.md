# Chat Long Paste Text Attachment

## Background

The chat input uses Lexical for the body. Pasting very long text directly into it makes editor serialization, draft sync and the mobile input experience heavy. The existing attachment chain can already send `text/plain` file attachments, so long text paste enters attachment semantics instead of growing the body further.

## Product rules

- Only plain text in the clipboard is handled.
- When the plain text is at least 5120 UTF-16 code units, the paste no longer inserts the content into the input body; it is written to the host temp directory and a local file attachment is created.
- The trigger does not depend on line count: a single very long line of JSON, log or base64 also becomes an attachment; a short multi-line text below the threshold keeps the default browser and Lexical paste behavior.
- Line count is still computed compatibly with `\n` / `\r\n` / `\r`, but serves only as display metadata of the attachment chip and plays no part in deciding whether to convert.
- If the same paste contains files, the file attachment logic takes priority, so screenshots, dragged-out text files or other attachment forms are not mistaken for body paste.
- If creating the host temp file fails, the paste stays intercepted and an attachment error is shown; the long text is not put into the body as a fallback.
- Conversion to an attachment does not rewrite the existing input body; an empty body may be submitted with only the attachment.
- The attachment count reuses the chat attachment cap: at most 8.

## Attachment data

A long-paste attachment is recorded on the UI side as `sourceKind: "clipboard-text"` and keeps:

- `lineCount`: line count of the original clipboard text.
- `charCount`: character count of the original clipboard text.
- `sizeBytes`: UTF-8 byte count after the host writes the temp file.
- `filename`: a machine-traceable `.txt` file name, for example `pasted-text-20260627-153012.txt`.
- `localPath`: host temp file path.

The long text is written to `{ZCODE_DATA_BASE_DIR || HOME}/.zcode/tmp/paste-attachments/YYYY-MM-DD/`. The file name is a timestamp name plus a random suffix, to avoid exposing body content or collisions. The send protocol reuses the existing `kind: "file"`, `mimeType: "text/plain"`, `localPath` route with the `sourceKind: "clipboard-text"` marker and no `textContent`, so long text does not enter the prompt payload or model context directly.

After receiving the marker the Agent must treat it as a user-uploaded temporary local file attachment: the model request contains only a file-path attachment reference, the file body is not read automatically, and no `prompt_attachment` system reminder is generated. The temp file content enters context only when the model later calls a file-read tool explicitly. Ordinary small text files uploaded by the user keep the existing behavior and can still be projected as Read-like attachment context.

Plain Web has no host file system and does not support this capability; mobile Web remote control must write to the connected desktop host temp directory through the shared-host/platform proxy, and must not fake a path in the phone browser.

## UI

The composer attachment area keeps a one-line chip:

```text
[clipboard-pen-line] 粘贴文本 · 128 行 [x]
```

- The icon is lucide `ClipboardPenLine`.
- The title uses i18n copy ("粘贴文本", pasted text) and does not show the machine file name.
- The line count is shown as metadata on the same line; when space is short the title/metadata truncate as a whole and the delete button stays fixed on the right.
- The chip body and the delete button overlay both use `background` as the base color, so the right-side mask and the attachment body do not have different surface levels.
- The delete button follows the side pane tab: a close area overlay shown on hover/focus on the right of the chip, with a gradient mask over the end of the text, so the line-count text and the button do not squeeze each other.
- The visual style reuses the existing inline attachment chip and adds no card container.

## Cross-platform boundary

- Desktop, Web and mobile remote control all use the same UI paste logic and the same prompt attachment protocol; no new runtime, and the shared-host attachment architecture is unchanged.
- The feature only affects composer input organization before submit and does not change the task stream semantics of desktop continuous and web remote replayable.
