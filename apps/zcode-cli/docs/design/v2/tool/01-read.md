# Read Tool

## Purpose

`Read` reads files from the local filesystem: text, images, video and PDF. Jupyter Notebook support is a follow-up item.

## Input contract

`Read` input is a strict object:

| Field       | Type     | Required | Description                                                                                                                 |
| ----------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `file_path` | `string` | yes      | Path to read. Relative paths resolve against the session cwd; absolute paths are normalized and handed to the filesystem adapter |
| `offset`    | `number` | no       | Line to start from, non-negative integer. Defaults to `1`                                                                    |
| `limit`     | `number` | no       | Number of lines to read, positive integer                                                                                    |
| `pages`     | `string` | no       | PDF page range, for example `1-5`, `3`, `10-20`; at most 20 pages per call                                                  |

Design requirements:

- The model prompt must say `file_path` may be absolute or relative to the session cwd; the runtime always normalizes it to an absolute path. The model should prefer user-provided or already-resolved absolute paths to avoid ambiguity.
- `offset` and `limit` are for large files or known target ranges. `offset` uses model-visible line numbers: `0` and `1` both mean line 1; the adapter converts to a zero-based line offset internally.
- Without an explicit `limit`, at most the first `2000` lines are read; with an explicit `limit`, `limit` lines are read.
- `pages` appears in both the provider-visible schema and the executor schema only when the current turn's model has `supportsPdf=true`. For `false` / `undefined` the existing Read shape is kept and the field is rejected.
- PDF `pages` supports a single page `N`, a closed range `N-M` and an open tail range `N-`. Pages are 1-based; at most 20 pages per call, so an open tail range is rejected as "more than 20 pages" instead of being expanded locally to an arbitrary limit.
- The model prompt must say: when the user provides an image, screenshot or supported image path, use `Read` first; do not use `Bash` to read base64, call `file`/`identify` or write temporary scripts instead of visual reading. `Bash` is only for listing directories, finding paths, or handling file types `Read` does not support.
- Supported today: text, common images (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`), video (`.mp4`, `.m4v`, `.mov`, `.webm`, `.mkv`, `.avi`) and PDF (opened by model capability). Jupyter Notebook, SVG and device paths are follow-up items; unimplemented capabilities must not appear in the provider-visible prompt.

## Output contract

The output is a union discriminated by `type` (`notebook` is a follow-up item):

| `type`           | Content                                                           |
| ---------------- | ----------------------------------------------------------------- |
| `text`           | `filePath`, `content`, `numLines`, `startLine`, `totalLines`      |
| `image`          | base64 image, MIME type, original size, optional dimension info   |
| `video`          | base64 video, MIME type, original size                            |
| `notebook`       | notebook path and cells                                           |
| `pdf`            | PDF path, base64, original size                                   |
| `parts`          | extracted PDF pages, output directory, page count, original size  |
| `file_unchanged` | File path. The same range was read before and is unchanged        |

The model-visible result is not plain JSON:

- Text content goes through a dedicated model-visible serialization, never generic `JSON.stringify(output)`.
- Text content is line-numbered like `cat -n`; the current provider-visible format is `<lineNumber>\t<fileContentLine>`.
- The line number and the first tab are a Read view prefix, not file content. Everything after the first tab, including extra tabs and indentation spaces, is the real content that a later `Edit.old_string` must copy.
- Text read results are Unicode logical text decoded by the filesystem adapter. The adapter must auto-detect UTF-8, UTF-16LE and common Chinese legacy encodings (GB2312 / GBK / GB18030) and keep the original encoding in metadata so mutation tools can write back faithfully; the model neither needs nor should transcode through shell or scripts before editing.
- For compatibility with historical sessions, log replay and model caches, `Edit` line-number prefix stripping must accept both `<lineNumber>\t<fileContentLine>` and `<lineNumber>: <fileContentLine>`; current `Read` output uses the former to keep the provider-visible baseline stable.
- After a successful non-empty text read, the provider-visible tool result contains only the conditional freshness / truncation reminder and the numbered body; no malware-reminder-style legacy suffix.
- User-submitted text attachments synthesize `Called the Read tool...` and `Result of calling the Read tool...` reminders. Reminder bodies of one attachment are joined with a single newline; different attachments in the same mid-conversation system turn are still joined with a blank line. When an attachment exceeds the default line limit, the prompt must say it is truncated to the first `2000` lines and tell the model to continue reading that file as needed.
- An empty file returns a system reminder.
- Structured text output carries the original file size, bytes actually read, a truncation flag and similar metadata for UI / ZCode app-server / debug display; the model-visible text shows only numbered content or an actionable error.
- Images become provider-visible image content blocks. For the Anthropic wire format, the `Read` image result must land in the matching tool result's `content` array, for example `{ type: "image", source: { type: "base64", data, media_type } }`, not as a `{ type: "image", base64, mimeType }` JSON string inside `tool_result.content`. At the AI SDK boundary the equivalent internal shape is `output: { type: "content", value: [{ type: "image-data", data, mediaType }] }`.
- The provider-visible `content` of an image tool result contains only media blocks. Even when the image was resized, the original size, display size and coordinate scale stay in the structured output only, with no extra text block, so the result shape does not drift with resizing.
- For OpenAI-like chat providers (`openai`, `openai-compatible`, `gateway`), the AI SDK serializes structured tool-result `content` JSON to text, so at the provider adapter boundary an image result must be split into a short-text tool-result placeholder plus a following synthetic user media message. The synthetic user message must come after the consecutive tool-result messages so it does not break OpenAI tool call / tool result pairing.
- The image payload is request-time structured media; session events, DB tool output and TUI/debug display store only a short text summary or an artifact reference, never base64 image text.
- Video is not transcoded or compressed. It is projected as a provider-neutral video block; the provider adapter converts it to `video_url` or a video source per endpoint. When the tool result has no native video part, it stays a short-text tool result and a synthetic user media message is appended after the consecutive tool-result blocks.
- When a successful Read result consists entirely of data-backed image/video/file blocks, the full media snapshot is written to the artifact store and recorded in original order in the matching `ToolStateCompleted.attachments`; `completed.output` keeps only a short text summary. Cold resume and in-session model switching rebuild provider-neutral blocks from the attachment artifacts, then project them to base64 wire for the current provider. A single request payload is never the DB source of truth.
- A notebook becomes a notebook-cell tool result.
- A PDF without `pages` is injected as a native `application/pdf` file block; with `pages` it returns a fixed summary and JPEG page images in ascending page order.
- Re-reading an unchanged file returns a fixed stub so the model refers to the earlier read in context.

ZCode keeps internal structured output separate from model-visible serialization so UI, SDK and provider stay decoupled.

## PDF execution and result contract

PDF execution does not bundle Poppler and does not introduce Python, PDFium, Pillow, PDF.js or any fallback. Provider-visible strings listed in this section are the verbatim baseline. `PdfDocumentPort` only owns external-command I/O; core owns capability checks, page semantics, file budgets and model result assembly.

```text
Read(file_path=.pdf)
        |
        +-- current turn supportsPdf !== true --> original Read schema / original text branch
        |
        +-- supportsPdf === true
              |
              +-- pages omitted
              |     +-- pdfinfo best effort (10s)
              |     +-- known pages > 10 --> require pages
              |     +-- <= 20MiB + %PDF- magic --> native PDF block
              |
              +-- pages present
                    +-- supportsImages === false --> <tool_use_error>
                    +-- validate N / N-M / N- and <= 20 pages
                    +-- pdftoppm -jpeg -r 100 (120s, PATH)
                    +-- existing image preparation per page
                    +-- summary text + ordered page images
```

### Dependencies and process boundary

- `pdfinfo` and `pdftoppm` are started through `ExecutionPort` as executable + argv; shell string concatenation is forbidden.
- Poppler is resolved only from the runtime `PATH`. ZCode does not download, compile or bundle Poppler with Desktop / SEA / remote runtime.
- `pdfinfo` is a best-effort total-page probe, only when `pages` is omitted, with a 10 s timeout. Ordinary execution or parse failures do not block the later native PDF read, but `cancelled` caused by runtime shutdown or user cancellation must bubble up the tool executor cancellation path.
- `pdftoppm` first gets a 5 s availability check with `-v`, then renders with `-jpeg -r 100`. The probe counts as available when `exitCode=0`, or `exitCode!=127` with non-empty stderr. A missing command returns verbatim `pdftoppm is not installed. Install poppler-utils (e.g. \`brew install poppler\` or \`apt-get install poppler-utils\`) to enable PDF page rendering.`. The subprocess render timeout is 120 s. Only the PDF `pages` branch uses a 150 s outer Read executor budget, leaving room for the availability check, page image normalization and temp-dir cleanup; other Read calls stay at 30 s. Only successful availability checks are cached, so installing Poppler does not require a process restart.
- Page rendering uses a unique temp directory, cleaned up after success, failure, cancellation and timeout. Temp-dir creation, enumeration and page-read failures all map to `io_error`; a cleanup failure must not override an existing primary Poppler error. With at most 20 pages per call, page files can be read in parallel after rendering; no 600-page streaming protocol is introduced.

### File and page boundaries

- A native PDF without `pages` is at most `20MiB`; it must first pass regular-file, non-empty and `%PDF-` magic checks.
- Page-extraction input with `pages` is at most `100MiB`; `offset` / `limit` have no effect on PDF.
- When the known page count exceeds 10 and `pages` is omitted, a clear error tells the model to use `pages`; one request reads at most 20 pages.
- PDF `pages` syntax and the 20-page limit must be checked in Read `validateInput`, before the PreToolUse Hook and permission checks. Invalid syntax uses `errorCode=7` and a fixed message; more than 20 pages uses `errorCode=8` and a fixed message; the executor projects both to `<tool_use_error>`, and the handler does not build the error envelope itself.
- These file errors use fixed messages kept verbatim: not a regular file `Path is not a regular file: <path>`; native PDF over 20MiB `PDF file exceeds maximum allowed size of 20MB.`; page-extraction input over 100MiB `PDF file exceeds maximum allowed size for text extraction (100MB).`; missing `%PDF-` magic `File is not a valid PDF (missing %PDF- header): <path>`. Capability combination, dependency injection, cancellation and temp-dir I/O use local stable errors.
- `pdftoppm` `Wrong page range given` must map to a clear error with the document's total pages and the legal range; `last page (0)` maps to `corrupted` with a clear empty-page-tree message. On the input side only Poppler's explicit `I/O Error:` / `Permission Error:` are recognized; password protection is recognized only by a `password` diagnostic in stderr; corruption only by `damaged` / `corrupt` / `invalid` or known trailer/xref structure errors. A process that succeeds but yields no page images also maps to a clear `corrupted`; unrecognized stderr uses `process_failed`; missing Poppler, cancellation and timeout each have their own stable error.
- The mapping from `PdfDocumentPortError` to Read tool error codes is maintained in one place in core: `unavailable -> PDF_CONFIGURATION_ERROR`, `corrupted -> PDF_INVALID`; timeout, password protection, page out of range, permission, generic I/O and unknown process failure each use their own `PDF_*` code. Cancellation keeps the executor cancellation path and must not degrade to a business error.
- `pages` applies only to `.pdf`; a compatibility call that passes `pages` for a non-PDF must not change ordinary Read behavior.

### Provider-visible tool result

- Without `pages`: `PDF file read: <filePath> (<size>)` carrying the native PDF file block.
- With `pages`: `PDF pages extracted: <count> page(s) from <filePath> (<size>)`, followed by page images in ascending original page order.
- File size uses one decimal with a trailing `.0` stripped, for example `1536 bytes -> 1.5KB`, `2048 bytes -> 2KB`.
- No `<Page_N_image>`, `<Page_N_parse_result>`, text layer, PNG or 120 DPI, and the old 600-page semantics are not kept.
- Anthropic Messages and OpenAI Responses keep structured text/media tool results. OpenAI Chat Completions uses ZCode's existing generic projection: the `role: tool` message holds the summary and per-page image text placeholders, and the real page images go in original order into one synthetic user message right after the consecutive tool-result messages; PDF adds no dedicated placeholder suppression rule.
- Live, resume, fork and cold start restore the same order through the existing tool media artifact + `modelContentLayout`; no PDF-specific manifest or persistence protocol is added.
- E2E must issue a `Read` tool call from the real runtime and assert, at a local provider capture endpoint, the final OpenAI Chat Completions HTTP body; tests must not call message conversion helpers directly. The first tool-result request and the cold-resume request after recreating the runtime must contain the same summary and same-order page image data URLs, covering executor, artifact persistence, history recovery and provider serialization end to end.
- `supportsPdf` and `supportsImages` are independent: a native PDF without `pages` depends only on `supportsPdf`; with `pages` and a model that explicitly lacks image support, a unified tool error is returned before any Poppler I/O.
- Read images, PDF page images, native PDF and video share a `40MiB` aggregate request-media budget, measured in full data URL bytes; a single video must still satisfy the `30MiB` raw file limit. There is no PDF-specific budget or exemption. The budget applies only to the current provider request copy and keeps the existing semantics: latest user media first, history media kept by recency, stable placeholders.

## Behavior semantics

Core flow:

1. Expand a relative path against the session cwd and normalize to an absolute path.
2. The current version does not hard-reject paths outside the workspace and only normalizes absolute paths; the filesystem permission adapter will later own ask/deny for outside-workspace reads and writes.
3. Validate the PDF page range.
4. Apply permission deny rules and special-path checks.
5. Pick a read strategy by type.
6. Apply token/size limits to text and notebooks.
7. For text files, `FileSystemPort` does bytes-to-Unicode decoding, LF normalization and records the original `encoding` and `lineEndings`; content that cannot be reliably judged as text, or has mixed/unsupported encodings, returns a stable `unsupported` error and never shows garbled text to the model.
8. Record `readFileState` for the later read-before-write protection of `Edit` and `Write`.
9. Dedup repeated reads of the same file and range: if mtime is unchanged, return `file_unchanged`.
10. Images and PDF extracted pages reuse the existing dimension, API byte budget and token budget compression.
11. Video gets format detection and the `30MiB` input limit check, with no transcoding or compression.
12. Large PDFs require paged reads or page extraction.

### Video budget

- `READ_VIDEO_MAX_INPUT_BYTES = 30 * 1024 * 1024`, checked on raw bytes.
- MP4, M4V, MOV, WEBM, MKV and AVI are supported; the extension-to-MIME mapping shares one source of truth with prompt attachment parsing.
- An oversized file returns a stable error; model-I/O records must redact the video base64 body.

### Image budget and compression

ZCode's image `Read` uses a multi-stage protection strategy with a `2000px` longest-edge cap:

- `READ_IMAGE_MAX_BASE64_BYTES = 5 * 1024 * 1024`. A hard provider/API base64 payload cap, checked against the base64 string length, not raw bytes.
- `READ_IMAGE_TARGET_BYTES = READ_IMAGE_MAX_BASE64_BYTES * 3 / 4`. The default raw-byte target, about `3.75MiB`, leaving headroom before base64 inflation.
- `READ_IMAGE_MAX_DIMENSION = 2000`. A longest edge above this is scaled down proportionally; small images are never enlarged.
- `READ_IMAGE_MAX_INPUT_BYTES = 20 * 1024 * 1024`. Images above this input size return a stable error before the bytes are read, to avoid loading oversized media into memory.
- An empty image must return a stable error; empty base64 is never sent to a provider.
- Image MIME is determined by magic bytes; the extension is only a fallback for entering the image path and for unknown formats.
- If raw bytes, base64 bytes and dimensions are all within budget, the original bytes are kept.
- If only the size is over budget, format-preserving compression is tried first: PNG optimization/palette reduction, JPEG/WebP progressive quality reduction; only if that fails, convert to JPEG.
- If the dimensions are over, first limit to within `2000px`, then repeat format preservation, PNG optimization, the JPEG quality ladder and smaller-size fallback compression.
- Read also estimates the image's cost against the model output budget with `ceil(base64.length * 0.125)`; above `READ_MAX_OUTPUT_TOKENS`, compression continues with `maxBytes = floor((maxTokens / 0.125) * 0.75)`.
- Image output carries original dimensions, display dimensions, original bytes, converted bytes, compressed flag, resized flag and compression strategy. These belong to structured output only; model-visible content is always just the image media block, with no appended text whether or not resizing happened.

The current Node/SEA default adapter still uses pure-JS Jimp to keep the cross-platform packaging path stable. Jimp cannot re-encode WebP: a WebP within budget is kept as is, one over budget returns a stable recoverable error. If optional sharp/native or WASM WebP handling is introduced later, this spec's packaging, degradation and test strategy must be updated first.

<a id="文本大文件预算"></a>

### Large text budget

A text range read of a file over `10MiB` probes the encoding with the first `4096` bytes. The sample boundary is not the end of file: if the sample ends with an incomplete UTF-8 candidate sequence, the missing count is computed from the lead byte and the bytes received, only the missing `1–3` bytes of that sequence are read, and then the whole sample is strictly validated; UTF-8 must not be accepted just because streaming decode has not yet errored. An invalid continuation byte on the supplementary read enters the existing legacy detection; a short read keeps reading; a sequence still incomplete at EOF cannot pass UTF-8 validation. On a complete character boundary there is no extra sampling, no dropped trailing bytes and no fixed extension to another truncation point. Sampling stays heuristic: completing a UTF-8 candidate does not guarantee the real encoding is UTF-8 and does not validate the rest of the file. BOM and Chinese legacy encoding detection order is unchanged. The body is read from the start, reusing the same streaming decoder to join characters across chunks, without changing line ranges or output budget. Synthesized attachment Read shares this behavior.

ZCode text `Read` uses two budget layers:

- `READ_MAX_FILE_SIZE_BYTES = 256 * 1024`. Without an explicit `limit`, the adapter checks total file size first; above the limit it returns a `too_large` / `read_file_too_large` style error telling the model to use `offset` and `limit`.
- With an explicit `limit`, total file size does not block; the read uses the real line range of the full file. The implementation must not read the file head and slice in core, or the back half of a large file would never be readable.
- `READ_MAX_OUTPUT_TOKENS = 25_000`. The selected content of a range read is still checked against the model output budget; above the limit it returns `read_output_too_many_tokens` telling the model to narrow the range.
- `READ_DEFAULT_MAX_LINES = 2000`. Without an explicit `limit` and with the file size check passed, at most the first `2000` lines are returned.
- `resultBudget` is the last-resort fallback, not the normal path. Normally `Read` itself returns an actionable error or real range content and does not rely on executor truncation of huge output.

## Permission model

`Read` is read-only and concurrency-safe but still needs path permission:

- An explicit read deny has the highest priority.
- An explicit read ask comes before implicit allow.
- Edit permission may implicitly allow read but cannot bypass read deny/ask.
- Reads inside the workspace are allowed by default.
- Internal readable paths such as session memory, plan and tool results may be allowed.
- Reads outside the workspace are not intercepted at the core path-policy layer in the current version; later the default will be ask, with a suggested session read rule.

ZCode builds path permission as a unified filesystem permission adapter; `Read` only declares `getPath` and operation type `read`.

## Validation and errors

Failure paths (some still to be completed, see implementation status):

- Invalid PDF page range.
- PDF page range above the per-call maximum.
- Path hits a deny rule.
- A UNC path needs permission confirmation to avoid Windows NTLM leaks.
- A binary file that is not PDF, image or SVG.
- Device paths that block or output endlessly, for example `/dev/zero`, `/dev/stdin`.
- File not found, with cwd and similar-file suggestions.
- Text or notebook over the size/token budget.
- Video over the `30MiB` input limit.
- A large PDF without `pages`.
- Unsupported text encoding, suspected binary or mixed encoding returns a stable `unsupported` error so garbled text never reaches later `Edit.old_string` matching.

These errors keep stable error codes and structured reasons; the CLI entry layer formats them into human-readable hints.

## Implementation status (2026-05-08)

| Capability                          | Status      | Notes                                                                                                                                                                                                                                      |
| ----------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Basic text read                     | implemented | `Read` reads text through `FileSystemPort.readTextFile` and supports `offset` / `limit`.                                                                                                                                                    |
| Relative path resolved against cwd  | implemented | Path resolution does not depend on the host process cwd.                                                                                                                                                                                    |
| Hard block of outside-workspace paths | disabled  | The current version only normalizes paths and does not reject outside-workspace reads in core path-policy, because a subagent needs to read user-specified external repos or files; fine-grained ask/deny will converge in the filesystem permission adapter. |
| Image read                          | implemented | Common image formats and a resize adapter are supported.                                                                                                                                                                                    |
| Native PDF read and page extraction | implemented | `supportsPdf` conditional shape; native PDF or PATH Poppler JPEG page extraction, at most 20 pages per call; shares the `40MiB` encoded request-media budget with images and video.                                                           |
| Video read                          | implemented | MP4, M4V, MOV, WEBM, MKV, AVI; up to `30MiB`, no transcoding/compression, projected as a provider-neutral video block.                                                                                                                      |
| Model-visible line-number format    | implemented | Text output goes through `formatReadModelContent` → `addReadLineNumbers` into cat-n style `<lineNumber>\t<content>` (pinned by `tool-contracts.test.ts`) to avoid JSON escaping polluting `Edit.old_string`; `Edit` accepts both `<lineNumber>\t` and `<lineNumber>: ` prefixes on input.                                    |
| readFileState                       | missing     | `Read` does not yet record a full read cache, so later `Edit` / `Write` cannot detect unread, partial-read or stale mutations.                                                                                                              |
| Repeat-read dedup                   | missing     | The `file_unchanged` stub is not returned yet.                                                                                                                                                                                              |
| File type, device path and large-file protection | partial | Text large-file `256KB` total-size protection, real range read and `25_000` token output protection are done; binary and device-path failure paths are still to be completed.                                                      |

Follow-up priority: keep the large-text and read-cache semantics; PDF must not add a media-budget special fallback inside the Read handler, and the shared request-media policy stays owned by the runtime provider-request projection boundary.

`Read` is the state foundation of the file tool chain. ZCode builds it as a `FileReadService` plus `ReadTool` two-layer design:

- `ReadTool` owns schema, permission and tool result serialization.
- `FileReadService` owns type detection, range read, content budget and read cache updates.
- All file system I/O goes through `FileSystemPort`.
- `FileSystemPort` may be implemented by a local Node adapter or a remote/ZCode protocol client adapter; the Read tool must not import `fs/promises` directly.
- PDF, image and notebook handling are replaceable adapters, so the core tool does not depend on concrete libraries.
- `readFileState` records `path`, `mtime`, `content`, `offset`, `limit` and whether the view is partial.
- Every read and cache hit carries a `traceId` for replay and audit.
