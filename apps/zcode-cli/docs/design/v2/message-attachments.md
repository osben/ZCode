# Message Attachments and Multimodal Input

## Background

The original gap: ZCode's external input and provider-visible history were plain text only.
`ZCodeApp.submitPrompt(prompt: string)` / `sendInput(input: string)` took only text;
`AgentRuntime.executeTurn(input, attachments?)` had an attachment parameter that bootstrap, CLI, TUI and the
ZCode app-server never passed; `ModelInputMessage.content` was a `string`; the session store already had
`FilePart` but `session-history-hydrator` restored file parts only as `[Attached file: ...]` text; and
the ZCode app-server spec rejected embedded resources, images and audio until runtime attachments had a
stable schema.

## Current implementation state

Implemented:

- `PromptInput = string | { text, attachments }` is exposed by bootstrap; `submitPrompt()` and
  `sendInput()` both pass attachments to the runtime. Active turn steering is still a text queue; input
  with attachments during an active turn is rejected stably.
- CLI supports `--attach <path>`: common image extensions are passed as `image`, other paths as `file`.
  TUI image paste passes a data-URL-backed `image` attachment through `TuiReadClipboardImage`.
- The ZCode app-server `prompt` declares the image capability and turns the app-server `image` content
  block into a runtime `image` attachment; `text` and `resource_link` are still handled as text content
  and remote resources are not read automatically.
- `ModelInputMessage.content` is `string | ModelMessageContentBlock[]` with a runtime JSON schema
  covering `text`, `reasoning`, `image`, `file` and `resource_link` blocks.
- The runtime resolver turns inline/local image attachments into provider-neutral image blocks; images are
  limited to 2000 pixels on the longest side through `ImageProcessorPort.resizeToFit` before reaching the
  model; WebP keeps its original bytes in the Jimp adapter (no resize/transcode).
- Local text/file attachments are read as text blocks under the `text/plain` budget; over the limit a
  preview and a truncated fallback are written. Non-files, oversized images, bad data URLs and read
  failures become stable text placeholders and metadata, never a bad payload to the provider.
- A user message is persisted as a text part plus file parts; a file part stores `mime`, `url`, `source`
  and size/hash/preview/image/error metadata. `session-history-hydrator` restores usable image file parts
  as structured user image blocks.
- `toAiSdkMessages()` supports user image blocks, PDF file blocks, `stripMedia` placeholders and
  empty/bad data URL fallback, and generates model-visible error text from the Active Model
  `properties.input_format.support_image` / `support_pdf`.
- Media budget projection before the provider request: ZCode counts the provider-visible image/PDF data
  URL bytes before the model call, keeps the media of the latest real user message first and replaces
  older media with a readable placeholder; if the latest user message itself exceeds the budget a
  recoverable invalid-input error is thrown locally and the provider is not called (see "413 request body
  guard").
- Desktop GUI file picking passes `localPath` first and no longer serializes ordinary files as
  `dataBase64` attachments. The ZCode app-server converts the GUI protocol attachment
  (`kind/localPath/dataBase64/textContent`) into core `TurnAttachment { type, path/content }` at the
  `session/send` boundary. TUI/CLI and GUI share the core resolver: small text is still inlined as a
  synthetic Read result at `inlineTextMaxBytes = 64 KiB`; text over that threshold, non-text ordinary
  files and images over `INLINE_MEDIA_ATTACHMENT_MAX_BYTES = 20 MiB` deliver only a local path reference,
  so the model uses read tools as needed instead of stuffing large files into the prompt.
- Request-local image path projection: inline/paste images keep the data URL artifact as the recovery
  fact (durable artifact in `<storageRoot>/cli/artifacts/<sessionId>/`) and eagerly materialize a
  rebuildable real image file in `<storageRoot>/cli/image-cache/<sessionId>/`. Before the model request
  the path is ensured per artifact URI with singleflight: with image support the user content is the
  query, the image block and `[Image: source: <path>]`; when images are explicitly unsupported the image
  block is replaced by the existing omitted text but the path is kept. The path is ordinary request-local
  user text, not persisted, and does not enter the system reminder, runtime attachment or MCS. On resume
  with a missing cache it is rebuilt from the durable data URL artifact; an existing local file path is
  reused directly. The derived cache handles only MIME types that can produce a real image extension;
  unsupported image MIME types keep the original image/base64 provider chain with no cache/path and
  without interrupting the request. A real read/write or durable artifact failure for a supported MIME
  still fails explicitly before the provider call, so a stale path is never sent. Only inline images with
  a `zcode-artifact://` URI and local-file images with a real `path` take part in the path projection;
  other provider-ready inline images (including a missing URI or a data-URL URI) keep the original image
  block, go through the existing media capability projection only, try to generate no path, and are not
  blocked for lacking a durable artifact identity. No periodic cleanup or old-path migration is added.
- Video is an independent modality. CLI, V4 `AttachmentRef`, composer inline upload and Read can all
  produce a provider-neutral video block; the model catalog capability and the provider wire capability
  are gated separately, and unsupported video is stripped. Model capability is expressed by the Active
  Model `properties.input_format.support_video`; the 30MiB input limit is a ZCode global product policy of
  the same kind as image and does not follow catalog, session or turn model config. User and tool-result
  video both use `FilePart + zcode-artifact://` as the durable fact across providers/cold resume; the
  base64 a provider needs is projected only at request time. The video limit of core/Read is 30MiB; V4
  upload keeps the existing 20MiB, 64 chunks and 64MiB staging boundary; desktop continuous, mobile
  replayable and shared-host boundaries are unchanged. Large video transfer on Web/mobile is out of
  scope. Video shares the request-local path projection with image: an existing local file path is reused;
  an inline video is lazily materialized from the durable data URL artifact into
  `<storageRoot>/cli/video-cache/<sessionId>/` before the model request. With
  `properties.input_format.support_video=true` the video block and `[Video: source: <path>]` are kept; with
  `false` the video block is replaced by the existing omitted text and the path is kept. The video path is
  not persisted either and is re-ensured from the durable artifact on cold resume. Only an inline video
  with a `zcode-artifact://` URI or a local-file video with a real path takes part; unsupported MIME types
  keep the original base64/capability chain and generate no path. No cache cleanup, migration or other
  media-type semantics are added.
- Media preview: the composer and sent user rows share one media preview Dialog for image/video. Video has
  no UI whitelist by container or codec and is handed to the browser's native
  `<video controls playsInline>`; a native decode failure shows only a "this device cannot preview" hint
  without changing attachment upload, sending, persistence or model input. Reading a sent attachment is
  authorized by the stable identity of the current row and the attachment index; when the target FilePart
  is persisted the durable artifact of that turn is resolved first. Only when a new message has no
  persisted message anchor yet, or old history has no artifact, is the authorized original stable ref
  read. So hot state, cold recovery and repeated sends of the same path do not drift because the source
  file was deleted or changed. The hot-state original ref and the hydrated previewRef can both prove the
  same row/index attachment but do not authorize other paths; the session store reads the target
  message/parts exactly by session/message and does not scan or decode the whole session for one preview.
  A single read failure is reported only inside the Dialog and does not permanently disable the preview
  entry. Upload and image read keep the V4 20MiB total boundary. When a Desktop local session previews a
  sent video it first queries a local playback source authorized by the current row/index: a durable
  artifact preferably reuses the derived file in `cli/video-cache/<sessionId>`; only
  `metadata_only/local_ref` without an artifact uses the persisted stable path. Both are handed to the
  native `<video>` through a Desktop-specific media protocol, never read fully into the gateway/renderer,
  and so are not subject to the 30MiB model input limit. When an artifact exists but a playback path
  cannot be materialized, the mutable original path must not be used; it degrades to the existing chunked
  read. Web, mobile remote control and SSH/WSL/Docker workspaces return no remote path and keep the
  512KiB query with the 30MiB video preview limit. Closing, switching or unmounting a chunked preview
  still cancels later chunks; no upload staging expansion, new large-file copy, transcoding, PDF/audio
  preview, relay state or separate runtime is added.
- The Desktop-specific media scheme must be registered with `standard + secure + stream` before
  `app.ready`. `standard` makes Chromium treat it as a standard URL and read the tail metadata of non-fast-
  start MP4; without it a video whose `moov` sits after `mdat` is misjudged as undecodable in a sent
  message. The formal VI06 E2E uses a playable MP4 with a tail `moov` and verifies loading and seek for
  both artifact-backed and over-30MiB local-ref videos.

Not implemented or only partially:

- No standalone user attachment artifact store yet; small data URLs and resolved images may still be
  inlined into the file part. Snapshots of large media, GC, fork reference counting and the missing
  artifact fallback follow the phases below.
- TUI placeholder binding still relies on the exact placeholder string, not on `TextElement` byte ranges.
- The local file resolver covers only text files and images; the full prompt expansion, MIME sniff,
  artifacting and provider capability gate for PDF/SVG/directories/resources is not yet a unified resolver
  capability.
- The compact boundary does not yet record attachment statistics, `attachmentMessageIds`, strip refs, or a
  dedicated media-strip replay after context overflow.
- debug/trace do not yet fully show attachment storageKind, projection result, degradation reason and hash
  prefix.
- The "no video in phase 1" statements below describe only the initial phase and no longer represent the
  current state.

## Design points

### Input layer

User input splits into explicit variants:

- `Text { text, text_elements }`
- `Image { image_url }`
- `LocalImage { path }`
- `Skill` / `Mention`

`Image` is a provider-ready data URL or remote URL; `LocalImage` is only a local path that is read and
compressed/converted into a data URL only when the provider request is built. The distinction is key:
a local path suits UI editing and local history replay but must not be treated as stable content to send
to a provider directly.

More input-layer details:

- `TextElement` binds UI placeholders with a byte range + placeholder, so editing the image placeholder
  text does not misalign attachments.
- A local image entering the model generates ordered content `<image name=[Image #N]>`, `input_image`,
  `</image>`, giving the model a stable label.
- Model capability is expressed by `input_modalities`; both the TUI attach and submit paths check it, and
  disable or warn for models without image support.
- History for a model without image support normalizes image parts to placeholder text instead of
  dropping them silently.
- The SDK first layer supports only text + local_image: it merges text into the prompt and passes local
  images to the CLI as `--image`. A simple but stable entry compatibility strategy.
- When estimating context, base64 image payloads are replaced by a token cost estimated from
  detail/size, so the raw JSON size does not mislead compact decisions.

### Persistence and provider projection

The current ZCode session store form: a message consists of `MessageInfo + Part[]`, and attachments are
`FilePart`:

```typescript
type FilePart = {
  type: "file";
  mime: string;
  filename?: string;
  url: string;
  source?: FilePartSource;
};
```

`FilePartSource` is split into `file`, `symbol`, `resource` and records the start/end/value of the
placeholder text. This suits resume, MCP resources, symbol references and UI restoration better than
storing only `path`.

Provider transform rules:

- `text/plain` and directory files do not go to the model as file parts; they become text or a synthetic
  Read result at prompt construction.
- image/PDF media enter the AI SDK as file/media parts.
- `ProviderTransform.message()` decides by `model.capabilities.input` whether image/audio/video/pdf is
  supported; if not it is replaced by explicit error text asking the model to tell the user.
- An empty base64 image is replaced by `"ERROR: Image file is empty or corrupted..."`, so the provider
  does not report an obscure error.
- Media attached to a tool result goes into the tool result content if the provider supports tool-result
  media; otherwise it is extracted and appended as a synthetic user message:
  `Attached image(s) from tool result:`.
- On compact/replay `stripMedia` can replace media with placeholders like `[Attached image/png: file]`.
- The TUI uses virtual placeholders `[Image N]` / `[PDF N]` for images/PDFs; deleting a placeholder
  deletes the matching part; SVG is pasted as text, not as image base64.

### Trade-offs for ZCode

ZCode uses the durable part model as the persistence mainline since the repository already has the
`FilePart` / `FilePartSource` shape, and uses explicit input variants and lazy local image encoding so the
entry layer never disguises a local path as provider content.

- External input uses `UserPromptInput` / `UserAttachmentInput`, keeping the differences between local
  path, data URL and resource link.
- The session store keeps `MessageInfo + Part[]` and strengthens `FilePart` metadata, source, hash, size.
- Provider-visible history uses `MessageContentBlock[]`, projected from parts by hydration/the prompt
  builder.
- UI placeholders bind through `TextElement` / `source.text`, not by string scanning.
- Unsupported media returns a stable error or visible fallback in the first phase, never a silent drop.

## Architecture

Main skeleton: `MessageInfo + Part[]` in the session event log is the source of truth, projected into
provider messages before entering the model. So the TUI, resume, compact, rewind, fork and debug all work
around one durable part model instead of each path assembling strings.

### Message fact source

The persistence layer keeps three kinds of information:

- `MessageInfo`: role, session, time, cost/token, parent/fork/compact boundary and other metadata.
- `TextPart`: user-visible text, synthetic read results, error fallback, compact placeholder.
- `FilePart`: the attachment fact, not the provider file part. It records `mime`, `filename`, `url`,
  `source`, `sizeBytes`, `sha256`, storage location and recoverable state.

`FilePart.url` is a stable URI, not a "string that can be sent to the model directly":

- `file://...`: a local file reference at submit time, readable only by the attachment resolver.
- `data:<mime>;base64,...`: small provider-ready inline content.
- `zcode-artifact://<artifactId>`: content already in the attachment artifact store.
- `mcp-resource://...` or a `resource` source: content from MCP/resource links.

`FilePart.source.text` keeps the byte range and value of the placeholder in the user input. When the TUI
deletes `[Image 1]` / `[PDF 1]` the matching `FilePart` is deleted, rather than guessing by rescanning
same-named text.

### Prompt expansion

The user part is first expanded into "context the model can understand" when entering the session, but
the original `FilePart` is kept.

- `resource`: read through the MCP/resource adapter; text content produces a synthetic `TextPart`, binary
  content a `[Binary content: <mime>]` fallback, and the `FilePart` is kept.
- `file://` + `text/plain`: goes through the unified Read capability or an equivalent `FileSystemPort`
  read, supporting `start/end`, symbol range and budget limits; the model sees synthetic text with the
  "Called Read..." semantics plus the file content, and the session still keeps the `FilePart`.
- `file://` + directory: in the first phase a directory is not sent as a file part; it goes through a
  directory summary/Read result or an explicit error.
- `image/*` / `application/pdf`: not turned into synthetic text; resolved into a media attachment that
  enters `data:` or `zcode-artifact:` by size and is loaded at provider projection.
- Empty base64, corrupted image, MIME mismatch: produce a stable error text part, never a bad payload to
  the provider.

Module boundary: prompt expansion may only call controlled adapters/ports, and session/core must not call
`fs.readFile`, `fetch` or a shell directly.

### Storage layers

Large files cannot be stuffed into the part JSON of SQLite, and provider-ready base64 is not long-term
history. Four layers:

| Layer | Stores | Does not store | Purpose |
| ----- | ------ | -------------- | ------- |
| SQLite/session store | message/part metadata, text part, short preview, artifact URI, hash, size, MIME, source range | large base64, full binary, full large text | resume, rewind, compact boundary, debug |
| Attachment artifact store | original media, small/medium binaries, extracted text preview, reusable provider payload | session business state, full user input log | stable resume/fork replay, large-file references |
| Workspace reference | the local path, mtime, size, hash at selection time | provider payload | entry draft, error hints, re-resolving when needed |
| Provider projection | AI SDK `text` / `image` / `file` part | the persistent fact source | a single model request |

Provider projection must also guarantee a non-empty user message on the wire. Boundary for
attachment-only input:

```text
SQLite: one user(text="", file)
                    │
      ┌─────────────┴──────────────────┐
      │ live                           │ resume / rewind /
      │                                │ fork child resume
      ▼                                ▼
 real_user("")                  hydrate raw parts
 prompt_attachment                     │
      └─────────────┬───────────────────┘
                    ▼
              Agent in-memory history
                    │
                    ▼
              provider adapter
                    │
                    ▼
               "(no content)"

UI snapshot ──always reads the raw SQLite message──> one user bubble with the attachment
```

Persistence does not split messages; splitting happens only in the live/hydrate runtime/provider
projection. A text attachment successfully expanded into `prompt_attachment` may leave an empty
`real_user`, while media such as images stay in the structured user content. The empty `real_user`
envelope rebuilt by hydrate exists only in Agent memory and is neither written back to the session store
nor enters the UI snapshot. The fork commit only copies persisted facts; hydrate happens only when the
child session is later opened/resumed.

If the real user content is an empty string, or conversion leaves no AI SDK user parts, the adapter
projects it to the fixed English `"(no content)"` only at the final wire serialization boundary, so a
blank placeholder trimmed by some provider is not still judged a missing prompt. Strings of non-zero
length such as spaces and line breaks keep their value; user content that already has images, files,
resource links or non-empty text gets no fallback. The session store, user-visible query, title seed and
attachment facts always keep their original value, and `"(no content)"` may appear only on the provider
wire or in model-io diagnostics.

Default policy:

- Small text may be inlined as a text part; beyond the budget only a preview is inlined and the full
  content or a recoverable reference goes to the artifact store.
- Media is snapshotted into the attachment artifact store at submit time, so resume/fork does not depend
  on the user's local file being renamed or deleted later.
- A file over the attachment limit keeps only metadata and a stable error with no snapshot, so unusable
  large files do not silently occupy local storage.
- A small data URL may be stored in the part; a data URL over `sqliteInlineDataUrlMaxBytes` must go to an
  artifact, with only `zcode-artifact://...` in the part.
- A provider-ready data URL is a projection result, not a fact source, unless it is small enough and is
  itself the user input.
- Video provider payload is always generated from the artifact as data URL/base64; switching within a
  session and cold recovery must re-project by the current provider wire, and the message DB must not
  store only the temporary payload of one request.
- When the renderer restores inline image/video from drafts, history or replayable payloads, `sizeBytes`
  is display metadata only; before decoding the real byte count must be computed from the base64 body and
  the matching media limit enforced, so a missing or understated `sizeBytes` cannot bypass validation.
- Project input history is an independent legacy input recall capability, not a session media fact
  source. This phase stores only its existing file/image/url projection; video must not pretend to be
  persistable by widening the InputHistory contract, and the entry layer should project the supported
  attachment types explicitly.

Initial thresholds are expressed as code constants or config items, with no new environment variable:

- `inlineTextMaxBytes`: 64 KiB, converted directly to a text part within budget.
- `textPreviewMaxBytes`: 32 KiB, upper bound of the large-text preview.
- `sqliteInlineDataUrlMaxBytes`: 256 KiB, beyond which artifacting is required.
- `mediaSnapshotMaxBytes`: 20 MiB, beyond which the file is rejected or only metadata is kept. Lower limits
  of a specific provider are gated again by the provider adapter.
- `toolAttachmentMaxBytes`: 20 MiB, tool-produced media enters the same artifact store.

If these thresholds are later exposed as config, config precedence, error behavior and test coverage must
be written separately; do not add `ZCODE_*` environment variables directly.

### Projection layer

A separate projection entry, so `session-history-hydrator`, compact and provider transform do not each
carry their own rules:

```typescript
interface MessageProjectionOptions {
  mode: "live" | "resume" | "compact" | "replay";
  stripMedia?: boolean;
  toolOutputMaxChars?: number;
  maxAttachmentBytes?: number;
}

interface MessageProjector {
  toModelMessages(
    messages: StoredMessage[],
    model: ModelDescriptor,
    options: MessageProjectionOptions,
  ): Promise<ModelInputMessage[]>;
}
```

Projection rules:

- `live/resume` keep, by default, as much media as the current model supports.
- The first `compact` request follows the model capability and media budget projection; after a
  media-too-large error the retry passes only placeholders and necessary metadata.
- If an artifact is missing, `replay` becomes `[Missing attachment: <name> <mime>]`.
- When the provider does not support a modality, a stable error text part is generated, for example
  "Cannot read image/png because this model does not support image input."
- Tool result media prefers the tool-result content; when the provider does not support tool-result media
  but supports user media, a synthetic user message is appended.

<a id="413-请求体防线"></a>

### 413 request body guard

A 413 caused by images is an HTTP request body problem and must not rely only on token compact. Even if
the image token estimate is low, the base64 JSON body may exceed provider, proxy or gateway limits. So the
provider request projection layer must enforce a hard byte budget:

- Before each provider call, images, PDFs, other binary files and video share one `40MiB` request media
  budget. The UTF-8 byte count of the complete data URL is counted uniformly, including base64 and the URL
  prefix; attachments already projected to text are not counted. Video has no separate request budget.
- `media-budget.ts` is the only request budget implementation; ordinary conversation, compact/summary,
  Memory and goal-completion verification all project by model capability first and then apply this
  budget. Only the current request copy is modified, not session messages, tool results or artifacts, so
  persistence and recovery chains keep their semantics.
- Media in the latest real user message counts as current-turn input and is kept first, so a screenshot
  the user just uploaded is not pushed out by historical images.
- Historical media is kept by recency; old media beyond the budget is replaced by the attachment
  placeholder generated by `modelMessageContentToText()` plus a note that it was omitted for the media
  budget.
- If the current-turn media itself exceeds the budget, a recoverable `invalid_input` is thrown at once
  with the single error code `MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE`, with no split by attachment
  type and no provider call.
- The first compact/summary request follows the same budget; after a provider media-too-large error the
  existing placeholder retry strategy is used.
- When media is omitted a debug log records the media bytes before/after projection and the kept and
  omitted counts.

The single-image resize and the single-video `30MiB` raw file limit are still enforced at the attachment
input/Read layer; the request layer only handles the encoded total budget and does not recount the raw
video bytes. A video of exactly `30MiB` already has `40MiB` of base64 after encoding and exceeds the
request budget with the URL prefix, so passing the single-file check does not guarantee the request can
be sent.

`40MiB` reserves space for non-media content such as the body, but text, tool definitions and the JSON
envelope are not counted and the whole HTTP body is not guaranteed to stay under `50MiB`. No
provider-specific budget or persisted state is added.

## Goals

The first phase supports user messages carrying local files, images and resource links, and safely injects
the content the current model can consume into the model request.

Core goals:

1. A provider-neutral message content block and attachment schema.
2. CLI/TUI/ZCode app-server/bootstrap/runtime/session store use the same attachment contract.
3. Images enter the provider as image content blocks on models supporting image input; otherwise a
   stable, explainable degradation.
4. Text files can be inlined within budget; large and binary files keep only a summary, metadata and a
   traceable reference and are not stuffed into the context.
5. resume, compact, rewind, debug and the event log can all observe and restore attachment state.
6. UI placeholders and attachment references have explicit range/source binding, so editing never
   mismatches an image or file.

Non-goals:

- No audio, video, directory batch upload or automatic remote URL download in the first phase.
- The first phase lets the business layer neither read `fs` directly nor access the network; attachment
  resolution must go through adapters/ports.
- No promise to support all provider-private formats in the first phase; only text/image/PDF/file-like
  content the AI SDK can express stably, with provider differences in the model adapter.

## Contract

New entry-layer input contract:

```typescript
type UserPromptInput = {
  text: string;
  textElements?: TextElement[];
  attachments?: UserAttachmentInput[];
};

type UserAttachmentInput =
  | { type: "local_file"; path: string; placeholder?: string }
  | { type: "image"; imageUrl: string; placeholder?: string }
  | { type: "resource_link"; uri: string; name?: string; title?: string; mimeType?: string };

interface TextElement {
  byteRange: { start: number; end: number };
  placeholder?: string;
  attachmentId?: string;
}
```

The entry-layer `local_file` only expresses that the user picked a local file and is not provider-ready
content. Only the attachment adapter/prompt builder can resolve it into text, a data URL, an artifact ref
or a fallback.

New provider-neutral content block:

```typescript
type MessageContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
      dataUrl: string;
      detail?: "auto" | "low" | "high" | "original";
      source: AttachmentRef;
    }
  | {
      type: "file";
      mediaType: string;
      name?: string;
      uri?: string;
      dataUrl?: string;
      text?: string;
      source: AttachmentRef;
    }
  | { type: "resource_link"; uri: string; name?: string; title?: string };

interface AttachmentRef {
  id: string;
  kind: "local_file" | "resource" | "inline";
  uri?: string;
  path?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  placeholder?: string;
}
```

The session `FilePart` gets extra storage metadata, extending the existing `FilePart` shape for large
files:

```typescript
interface AttachmentStorageMetadata {
  sizeBytes?: number;
  sha256?: string;
  storageKind: "inline" | "artifact" | "local_ref" | "remote_ref" | "metadata_only";
  artifactUri?: string;
  originalUrl?: string;
  recoverability: "provider_ready" | "rebuildable" | "preview_only" | "metadata_only" | "missing";
  preview?: {
    text?: string;
    truncated?: boolean;
    originalBytes?: number;
  };
  errorCode?: string;
}
```

`metadata_only` is not a successful attachment: the user did submit it, but ZCode did not keep the
original content and the model can see only an explainable fallback.

`ModelInputMessage.content` extends from `string` to:

```typescript
type ModelMessageContent = string | MessageContentBlock[];
```

Compatibility:

- system, assistant and tool prefer string in the first phase.
- A user message uses a block array; plain text input may stay a string or be normalized into a single
  text block.
- text/plain files become a text block first; image/PDF become file/image blocks; a directory is only a
  text description or an explicit refusal.
- `modelInputMessageJsonSchema` must be extended in sync; cross-process and session boundaries cannot rely
  on TypeScript types alone.

## Attachment resolution boundary

An `AttachmentPort` (or an existing controlled I/O adapter layer) is responsible for:

- Normalizing local paths: relative paths based on the session cwd, absolute paths through the
  workspace/sandbox policy.
- Reading metadata: file name, MIME, size, hash, mtime.
- Deciding by MIME and size whether it can be inlined, converted to an image, used as a text summary, or
  only referenced.
- Reading images as base64/data URL; core does not read files directly.
- Images go through `ImageProcessorPort.resizeToFit` by default, limiting the longest side to 2000 pixels
  before entering the model; supporting original detail later must be gated by model capability. The
  Node/SEA default implementation uses the pure-JS Jimp adapter so image processing does not depend on
  platform-native binaries.
- WebP gets no resize/transcode in the first phase. Jimp does not support WebP encoding by default, so the
  adapter must return WebP bytes unchanged with `resized: false`, keeping the `image/webp` MIME; if WebP
  resize is introduced later, the new WASM/native resource loading, SEA packaging and degradation behavior
  must first be defined in this spec.
- SVG is not sent as image base64 and is preferably handled as a text file.
- PDF in the first phase can be a media file block or a fallback; a model without PDF support must get
  explicit error text.
- Text files are read under a unified budget; over the limit a preview + artifact ref is returned.
- Data URLs are validated for non-empty base64 and legal MIME; empty or corrupted images turn into a
  stable error and the bad payload is not sent to the provider.
- MIME is sniffed from content first; the file extension is only a fallback.

The business layer only expresses the intent "the user attached this resource" and does not call `fs`,
`fetch` or `process.env` directly.

## Entry paths

### CLI / TUI

The first phase recommends explicit input forms instead of magic parsing of all text:

- `zcode --attach path --prompt "..."`.
- The TUI supports pasting or selecting files to produce an attachment list; images/PDFs render as virtual
  placeholders `[Image N]` / `[PDF N]`.
- After an external editor or manual deletion of a placeholder, the matching attachment must be deleted or
  reordered per `TextElement` / `FilePart.source.text`.
- UX such as `@file` in plain text or dragging a path can come later, but its result must also be turned
  into the same `AttachmentRef`.

### Bootstrap API

The app API accepts attachments:

```typescript
interface UserPromptInput {
  text: string;
  attachments?: UserAttachmentInput[];
}

submitPrompt(input: string | UserPromptInput, options?: SubmitPromptOptions): Promise<TurnResult>;
sendInput(input: string | UserPromptInput, options?: SendInputOptions): Promise<SendInputResult>;
```

`UserAttachmentInput` is an entry-layer schema that an adapter resolves into stable
`MessageContentBlock[]` before the runtime. For compatibility with the current API, `string` equals
`{ text: string, attachments: [] }`.

### ZCode app-server

The ZCode app-server currently supports `text` and `resource_link`. Next:

- `text` -> text block.
- `resource_link` -> resource_link block, without auto-reading the network for now.
- embedded image/resource -> resolved into an attachment block.
- Unsupported blocks return `invalid_params`, with a stable `unsupported_content_block` reason in the
  error.

## Provider Transform

`toAiSdkMessages()` turns ZCode content blocks into AI SDK `ModelMessage`:

- text block -> `{ type: "text", text }`.
- image block -> AI SDK image part.
- resource/file text preview -> text part.
- unsupported file/audio/video -> text fallback containing the file name, MIME, size and a note that "the
  model did not receive the original binary".

Model capability:

- Use the Active Model `properties.input_format`; do not re-infer from the model ID, provider type or a
  separate capability map.
- If the target model does not support image, no image part is sent; a stable error or degraded text is
  used.
- For the first phase, the recommendation is to return a user-actionable error rather than silently
  ignore it when the user explicitly attaches an image but the model does not support images.
- The `mime -> modality` decision is centralized in the transform layer: `image/* -> image`,
  `application/pdf -> pdf`, audio/video to be extended later.
- Tool result media prefers the tool-result content; if the provider does not support tool-result media
  but the model supports user-side media, a synthetic user message carries the attachment.
- compact, summary and cross-model resume can pass the `stripMedia` option to turn media into
  `[Attached <mime>: <name>]` text.

## Session Store and recovery

### First-send and cold-recovery consistency

With the same model config and the same recoverable attachment facts, ordinary send, queue consumption
and resume / rewind / fork recovery must share the user message assembly logic. Body first, ordinary
attachments in submit order, pasted images last; text files still project as separate `prompt_attachment`
without changing the synthetic reminder or empty-body anchor semantics. Whether an image came from a paste
is decided by the persisted attachment origin, not by the temporary media `source.kind` after recovery.

```text
CLI / Desktop / mobile input → Agent resolve → unified user message assembly → provider projection
                                  ↓
                        TextPart + FilePart (the only persistent fact)
                                  ↓
resume / rewind / fork → hydrate content → same user message assembly → provider projection
```

A path-reference attachment stores `metadata.pathReferenceText`, the complete three-line description first
sent to the model, including the path, the degradation reason and the read hint. Recovery uses this text
first, without re-reading the file or regenerating wording by current resolution rules. `preview` still
means the file content preview and is not reused as the attachment description field. This optional field
is saved in the existing FilePart JSON with no database migration; consumers validate that it is a string.

Old messages use the same unified order. Without a valid `pathReferenceText` the existing one-line
placeholder is kept; the lost reason is not guessed and history is not backfilled or rewritten. The first
switch of old history to the fixed projection may change the cache prefix; newly saved messages must keep
the same attachment order and description text in the final provider request in both hot state and after
cold recovery. The existing degradation rules for missing media artifacts, model capability changes and
compact still apply.

Regression covers path references, clipboard text, PDF, mixed local and pasted images, video, plain text
and attachment-only sends; also queue consumption, the MCS switch, a real SQLite close and reopen, and the
final provider payload. Desktop cold recovery is verified by sending an attachment, continuing the
conversation, restarting and continuing again; mobile replayable uses the same Agent persistent facts and
adds no client message assembly state.

On persistence:

- The user's original text is saved as a text part.
- Each attachment is saved as a `FilePart` with `filename`, `mime`, `url/source`, hash and size metadata
  filled in; `source` must keep the `file` / `resource` / `symbol` type and not degrade to a single path.
- A local file may save a `file://` / workspace-relative source; the provider-ready data URL or artifact
  ref is saved as a resolved product, avoiding repeated guessing on resume.
- Large or converted products go into the artifact store, with only a reference in the part.

On recovery:

- `session-history-hydrator` must not just generate `[Attached file: ...]`.
- Text/image blocks that can still be rebuilt safely are restored as content blocks.
- Missing, over-limit or model-unsupported attachments are restored as stable text fallback, with
  recoverability metadata recorded.
- Local UI drafts/history may restore local paths and placeholders; provider history may use only resolved
  safe content or fallback and must not treat a local path as an image URL.

On compact:

- The summary model defaults to `stripMedia: true` and receives no original images, PDFs, binaries or
  large base64.
- Media in the compact input is replaced by `[Attached <mime>: <filename> <size>]`, and large text files
  by preview + truncated marker.
- The compact boundary records `attachmentMessageIds`, the number of stripped attachments, total bytes and
  recoverable artifact refs, for debug and later forks.
- Attachments from before the compact boundary remain in the artifact store but by default do not re-enter
  the active model context; when the user continues the discussion the model should know "there was an
  attachment before but the media content was removed from the summary context".
- Recent-context attachments after the compact boundary are kept as normal blocks until the next compact.
- If it still exceeds the model context after `stripMedia`, a stable compact failure reason such as
  `context_too_large_after_media_strip` is returned, prompting the user to shrink the input or start a new
  session.
- Auto continuation after a provider context overflow can re-project with `stripMedia` again and append a
  synthetic user text explaining the media was removed; large files are not re-read in the error recovery
  path.
- Context token estimation must not count the raw base64 length; image data URLs use a fixed or
  size-related estimate, PDF/large text use preview and provider-specific estimates.

## Rewind, fork and attachments

The relationship between attachments and rewind/compact needs separate design, otherwise large files are
easily deleted by mistake, misread or stuffed into the context repeatedly.

- Conversation rewind deletes or hides message/parts after the target point but does not delete attachment
  artifacts at once; the artifact becomes unreferenced and is handled by a later GC.
- File-only rewind restores a workspace checkpoint and does not change submitted attachment snapshots. The
  image/file content at submit time is defined by the artifact and is not reinterpreted when workspace
  files change after the rewind.
- If the user attached only a `metadata_only` large file, rewind/fork can keep only the metadata and the
  error fallback and must not pretend it is recoverable.
- A rewind in a session before the compact boundary still forks per the rules of `rewind-compact.md`; the
  fork copies message/part metadata and shares the immutable artifact URI or increments the reference
  count.
- If a fork finds the parent session artifact missing, it must turn the matching `FilePart` into a
  `[Missing attachment: ...]` fallback and record `attachment_artifact_missing` in the fork debug event.
- `partID`-level rewind/cleanup should delete the matching attachment part by `FilePart.source.text`;
  after the placeholder in the user text is deleted no orphan attachment may keep being sent to the model.
- A checkpoint snapshot is the audit record of workspace file changes, not user attachment storage. The two
  artifact stores must not be mixed, but trace/debug should be able to correlate the checkpoint and the
  attachments of the same turn.
- Compact records `attachmentMessageIds` when generating the summary, so after rewinding to the compact
  boundary one can still explain "which attachments took part in the summary but whose original media is
  not in the active context".

## Security and errors

Key error codes:

- `attachment_not_found`
- `attachment_outside_workspace`
- `attachment_too_large`
- `attachment_unsupported_mime`
- `attachment_model_unsupported`
- `attachment_read_failed`

Logs and events:

- Record attachment count, MIME, size, hash prefix, resolution result and degradation reason.
- Never record full base64, full file content or full private user content.
- All attachment resolution, artifact writes and provider transforms carry the same `traceId`.

## Implementation phases

### Phase 0: spec and fixtures

1. Fix this spec and add the attachment, compact boundary and fork artifact relationship to
   `docs/design/v2/rewind-compact.md`.
2. Add test fixtures: small text, large text, PNG, JPEG, WebP, empty base64, corrupted image, PDF, SVG,
   directory, missing file, path with spaces.
3. Define the default threshold constants and error codes; add no environment variable.

### Phase 1: contracts and projection skeleton

1. Extend `ModelInputMessage`, the JSON schema and the session event payload of `@zcode/contracts`.
2. Extend the session `FilePart` metadata, keeping old part JSON readable.
3. Add `MessageProjector` to project stored messages into provider-neutral `MessageContentBlock[]`.
4. Update `MessageHistory` to support user content blocks while keeping the plain text path compatible.
5. Unit tests cover plain text compatibility, block JSON schema, unsupported modality fallback and
   `stripMedia` placeholders.

### Phase 2: attachment artifact store

1. Extract from the existing `ToolArtifactStorePort` or add an `ArtifactStorePort`, supporting
   binary/text artifacts, metadata, hash, size, MIME and stream/buffer reads.
2. The SQLite part stores only the artifact URI and metadata, no large base64.
3. `NodeToolArtifactStore` can keep serving tool text products; user attachment media uses the same
   infrastructure or a sibling namespace such as `cli/attachments/<sessionId>`.
4. Add an artifact GC design entry: this phase may only do the unreferenced query, with no auto delete.
5. Unit tests cover write, read, hash dedupe, missing artifact fallback and cross-platform paths.

### Phase 3: prompt expansion / attachment resolver

1. Add `AttachmentResolver` accepting `UserAttachmentInput` / `FilePart` and outputting synthetic text
   parts, file parts and artifact refs.
2. `text/plain` files use Read-equivalent semantics with preview/truncated.
3. image/PDF go through MIME sniff, size gating, artifact snapshot and data URL projection preparation.
4. SVG uses the text path; directories use a summary or an explicit error.
5. Resource links are read through the MCP/resource adapter; failures produce stable error text.
6. Unit tests cover path normalization, MIME sniff, empty/bad data URL, over-limit, missing and resource
   failure.

### Phase 4: entry wiring

1. The bootstrap API supports `submitPrompt(string | UserPromptInput)` and
   `sendInput(string | UserPromptInput)`.
2. CLI adds `--attach <path>`; multiple passes produce `FilePart` in order.
3. The TUI supports an attachment draft list and virtual placeholders; deleting a placeholder deletes the
   part in sync.
4. The ZCode app-server accepts `text`, `resource_link`, embedded image/resource; audio/video keep
   returning a stable unsupported.
5. All entries go through the same resolver and do not duplicate read logic.

### Phase 5: provider transform

1. Update `toAiSdkMessages()` to support text/image/PDF/file preview.
2. Gate image/PDF by `modalities.input` of the model catalog or the existing supports fields.
3. Implement the tool-result media strategy: keep in the tool result if supported, otherwise a synthetic
   user message.
4. The provider transform does not read local files directly and gets the provider payload only through
   the artifact store.
5. Unit tests cover image-capable, non-image, PDF-capable, tool-result media, empty base64 and unsupported
   modality.

### Phase 6: compact, overflow and rewind/fork

1. compact calls `MessageProjector` and forces `stripMedia: true`.
2. The compact boundary records attachment statistics, `attachmentMessageIds` and stripped refs.
3. Context overflow recovery uses the same strip-media projection and does not re-resolve local files.
4. rewind cleanup removes only message/part references; artifacts are GC'd lazily.
5. fork copies part metadata and shares immutable artifacts; a missing artifact turns into a fallback.
6. Update `docs/design/v2/rewind-compact.md` to merge these rules into the existing compact boundary and
   file checkpoint design.
7. Unit tests cover compact stripMedia, resume after compact, rewind to a part, artifact not deleted by
   mistake after rewind, fork missing artifact fallback.

### Phase 7: debug, observability and wrap-up

1. The debug event shows attachment count, MIME, size, hash prefix, storageKind, projection result and
   degradation reason.
2. trace covers resolver, artifact write/read, provider projection, compact strip and rewind cleanup.
3. Documentation adds user-visible behavior: which files enter the model and which keep only a
   preview/metadata.
4. Add OpenAI, Anthropic and OpenAI-compatible compatibility tests as provider differences require.

## Test requirements

Before finishing implementation run at least:

```text
npm run lint
npm test
```

Required scenarios:

- Plain text messages keep the existing behavior.
- A user message formed from an empty string, empty array or empty text parts becomes `"(no content)"` on
  the provider wire; spaces, line breaks, non-empty text and media-only content stay unchanged.
- A user message with text + image.
- An image-capable model receives the image part.
- A non-image-capable model returns a stable error or a stable degradation.
- Empty base64 / corrupted images are not sent to the provider and return stable error text.
- PDF model capability gating and fallback.
- SVG is handled as text.
- A tool result image converts correctly under providers that support / do not support tool-result media.
- compact stripMedia replaces media with placeholder text.
- The compact boundary records attachment message ids and strip statistics.
- After context overflow large files are not re-read; the artifact/fallback is reused.
- Conversation rewind does not delete attachment artifacts at once.
- File-only rewind does not change submitted attachment snapshots.
- fork keeps or degrades attachment references.
- Local file paths resolve cross-platform; Windows/macOS/Linux separators and paths with spaces do not
  break.
- Large files do not enter the model context directly; artifact/ref + preview instead.
- After session resume attachments are neither lost, duplicated nor wrongly replayed.
- The ZCode app-server returns stable invalid params for an unsupported content block.
- Logs and events do not leak base64 or full file content.

## Composer PDF alignment (2026-08-29)

Composer PDF uses the independent `TurnAttachment.type = "pdf"` and the shared `ZCodePromptPdfAttachment`.
Local/remote paths and Web V4 bytes are validated at admission for MIME, the 20MiB boundary and the `%PDF`
magic and written to a durable artifact; the session `part.data` stores only the FilePart's
`zcode-artifact://` link, MIME, file name and metadata. `pdf-cache/<sessionId>/` is the rebuildable derived
`.pdf` path used by requests and preview, and is not written to the DB, snapshot or replayable events.

Cold recovery and model switching re-materialize the path artifact-first; with `supportsPdf=false` the PDF
data is omitted before the provider request and `[PDF: source: <path>]` is kept, and switching back to a
supporting model restores it from the same artifact. The composer and sent rows keep the document card
form but uniformly use PdfViewer and an attachment range read authorized exactly by row/part; relay/main
store no PDF bytes or session business state.
