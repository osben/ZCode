# Video input support spec (base64-only)

> Request budget update: the separate video budget bucket below is a historical design. All media now share
> one `40MiB` encoded request budget, while a single video is still validated at `30MiB` of raw file size; see
> the [attachment request budget spec](../../apps/zcode-cli/docs/design/v2/message-attachments.md#413-请求体防线).

- Date: 2026-08-17
- Status: phase 1 being closed out (existing paths kept; this round completes provider effective capability, strict schema, catalog merge, bounded Read, tool-result media persistence and observability gaps). Web/mobile large-video upload architecture is not changed in this round.
- Branch: `feat/video-input-support`
- Scope: video input (no audio); composer attachments + the Read tool
- Implementation notes:
  - Both patches live in the **root** `patches/` (root package.json `pnpm.patchedDependencies`): measured, the CLI runtime resolves `@ai-sdk/*` from the root node_modules (`node-linker=hoisted`); apps/zcode-cli's own node_modules/.pnpm is a legacy artifact.
  - V4 upload keeps the existing 20MiB, 64 chunks, 64MiB staging bounds; this phase does not raise protocol resource limits for Web/mobile large videos.
  - Sent image/video reuse the same media preview Dialog; V4 upload stays at 20MiB, preview read is limited by media type (image 20MiB, video 30MiB), each frame still at most 512KiB.
  - After patch-commit an explicit `pnpm install` is needed for the patch to apply to the hoisted directory.

## 1. Background and findings

### 1.1 Existing media input is image-only

Existing media input is the **image base64 pipeline** only: read local file -> resize/byte budget ->
`{type:"image", source:{type:"base64", media_type, data}}`; there is no construction path for video/audio
content blocks. This spec extends the pattern to video.

### 1.2 Wire format facts

| Format                  | wire shape                                                                          | Source and facts                                                                                                                                                                                                                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| openai-chat-completions | `{"type":"video_url","video_url":{"url":"data:video/mp4;base64,..."}}`              | Format from the GLM-5V-Turbo / Kimi K3 official docs; this implementation sends only base64 data URLs                                                                                                                                                                                                                           |
| anthropic-messages      | `{"type":"video","source":{"type":"base64","media_type":"video/mp4","data":"..."}}` | **The official Anthropic Messages API currently has no video block** (input media is image/document only). This shape mirrors the image block (`type`/`media_type`/`data`) and is the consensus shape of Anthropic-style compatibility layers; whether each third-party anthropic-compatible endpoint accepts it must be tested |

Endpoint acceptance cannot be decided by `supportsVideo` in the model catalog alone: the model capability says
the model can semantically receive video, while the provider wire capability says the current adapter can
encode video into a legal request for the target API. The runtime effective capability is the intersection;
when either layer clearly does not support it, the existing strip-placeholder mechanism applies and the
request does not fail.

### 1.3 AI SDK blockers

- `@ai-sdk/anthropic@3.0.81`: file parts accept only `image/*`, `application/pdf`, `text/plain`; any other mediaType throws `UnsupportedFunctionalityError`.
- `@ai-sdk/openai-compatible@2.0.60`: no video branch (also throws).
- Fix: pnpm patch both packages with one `video/*` branch each (precedent: `patches/vitest@4.1.7.patch`).

### 1.4 zcode protocol status (before integration)

- Every image check across the chain is an exact `mime.startsWith("image/")` or an image extension, and video hits none: UI serialize lands as `kind:"file"`, CLI ref mapping as `type:"file"`, core as a `binary_file` path reference, Read as a vague `looksLikeBinary` error. **Video cannot ride on the image channel; a new channel is required.**
- The `ModelProviderModality` enum and the stored zod already contain `"video"`; the models-dev snapshot's `glm-5v-turbo` already declares `video` in `modalities.input`. Missing are the projection set (`PROTOCOL_MEDIA_INPUT_MODALITIES`) and the downstream capability field.

## 2. Architecture

### 2.1 Data flow

```
Scenario A: composer attachment           Scenario B: Read tool
[drag/paste .mp4]                         Read(file.mp4)
  | desktop: localPath, zero copy           | inferVideoMimeFromPath
  | Web: dataBase64 (V4 20MiB limit kept)   | readBinaryFile(<= global 30MiB, no compression)
  v                                          v
ZCodePromptVideoAttachment{kind:"video"}   ReadVideoOutput{type:"video"}
  v mapProtocolPromptAttachment /            | formatReadVideoOutput
    attachment-refs(isVideoRef)              v
TurnAttachment{type:"video"} ------> ModelVideoContentBlock{type:"video",
  v resolveLocalFileAttachment/inline          mediaType, dataUrl,
  30MiB check -> read base64 -> artifact       source}
  persistence                                  v
  v                                    tool-result-media-projection
user message content <------------   (video tool-result media always split into a
  |                                   trailing user part, uniform across provider
  v                                   kinds; image keeps the image-data path)
transform.ts: video block -> AI SDK file part{mediaType:"video/mp4", data: base64}
  |
  +- openai-compatible(patch) -> {type:"video_url",
  |    video_url:{url:"data:video/mp4;base64,..."}}
  +- anthropic(patch)        -> {type:"video", source:{type:"base64",
                                media_type:"video/mp4", data}}
```

### 2.2 Internal type (provider-neutral, isomorphic to image)

```ts
interface ModelVideoContentBlock {
  type: "video"; // not "video_url" - that is the openai wire dialect
  mediaType: string; // "video/mp4" etc.
  dataUrl: string; // data:video/mp4;base64,... (the only content form)
  source?: AttachmentRef;
}
```

### 2.3 Model capability and provider wire capability

```text
model catalog supportsVideo
          |
          +-- false ------------------------------> strip placeholder
          |
          +-- true / unknown
                    |
                    v
          provider adapter wire capability
                    |
                    +-- unsupported -------------> effective false -> strip placeholder
                    +-- supported / not explicitly limited -> existing video transform
```

- `openai-compatible` uses the Chat Completions wire and relies on the repo patch to emit `video_url`; a phase-1 supported path.
- `anthropic`-compatible providers rely on the repo patch to emit the `video` block that compatible endpoints agree on, still to be tested per endpoint.
- `providerKind: "openai"` currently uses the AI SDK OpenAI Responses, whose adapter rejects `video/*` file parts before sending; phase 1 therefore marks it explicitly wire unsupported and it does not enter the video transform.
- `gateway` / `custom` lack facts to prove uniform non-support, so no speculative blocking is added now.

### 2.4 Provider-neutral persistence and model switching

The session DB stores only media facts that can be rebuilt across providers: a `FilePart`'s MIME, file name,
size/digest and similar metadata, plus the `zcode-artifact://` URI pointing to the complete media snapshot.
The base64 wire is not a message fact and is generated only at request projection time.

```text
live tool/user media
        | snapshot
        v
session DB: FilePart -------> artifact store: immutable source media
        |                                      |
        | hydrate / model switch               +- read -> data URL / base64
        v
current-provider request projection
```

- User attachments keep using the user message `file` part; tool-produced media uses `ToolStateCompleted.attachments`; both point to the same kind of artifact fact source.
- In-conversation model switch and cold resume both hydrate the provider-neutral block first and then project for the current provider; the previous provider's wire payload is never reused as history fact.
- If a tool result's provider-visible content consists of text plus data-backed image/video/file blocks, media is written to `attachments` in order and the completed metadata keeps a small `modelContentLayout` with only text/attachment indices; resume restores the original order from it. It covers only pure media, MCP text/media and hook text/media shapes that exist today and introduces no general message serialization layer.
- If the artifact write fails, successful media must not silently degrade to metadata-only history (later switch/resume could not rebuild it); the current turn fails explicitly and the existing interrupted-tool recovery semantics close the tool call.
- Real user video and image share the request-local path projection: local-file reuses the absolute path accessible to the current runtime, inline artifact is lazily materialized to `cli/video-cache/<sessionId>` before the request. With capability `true`/`undefined` a video block + path is sent, with an explicit `false` an omitted text + path is sent; the path is not written to the session DB, and on cold resume the durable artifact is re-ensured as the fact.

### 2.5 Pre-send and sent media preview

Pre-send and sent attachments reuse `ChatMediaAttachmentPreviewDialog`, and only image/video count as
previewable media. Preview is best-effort renderer display and changes no upload, send, persistence or
provider input semantics:

```text
Composer File/object URL ----------------+
                                         +-> shared media dialog
sent user row + attachment index         |      +- image: existing preview
        |                                |      +- video: controls + playsInline
        v                                |                 |
CLI authorizes row/entity/ref            |                 +- loadedmetadata -> player
        |                                |                 +- error -> codec/format notice
        +- message anchor not persisted -+- authorized original stable ref
        v                                |
persisted user FilePart                  |
        +- durable artifact exists
        |      +- Desktop local -> .zcode video-cache path --+
        |      +- remote/web or path unavailable -> chunked artifact read
        +- no artifact
               +- Desktop local_ref -> authorized local path --+
               +- remote/web -> chunked stable-ref read
                                                            v
                                        Host asks Main to authorize realpath
                                                            |
                                                            v
                                      exact authorized path -> media protocol
```

- Every supported `video/*` MIME may enter the native `<video>`; no container/MIME allowlist may reject early. When the browser cannot decode MOV or a specific codec, a clear device-preview-unsupported message shows, and the attachment can still be sent.
- A sent-attachment query must authorize by the user row's stable identity and attachment index, then prefer the turn's persisted `FilePart.metadata.artifactUri` (or artifact URL). This keeps hot, cold-resume and repeated sends of the same path previewing the immutable media stored at that time; the hot original ref and the post-hydrate previewRef both pass authorization as long as they belong to the same row/index. Only when a new message has no persisted message anchor yet, or old history has no durable artifact, is the authorized original ref read. A single read failure shows an error only in the current Dialog and can be reopened and retried.
- V4 upload and image preview read stay capped at 20MiB total. Desktop local sent-video first requests the authorized local source: the artifact's `.zcode` derived path first, then `metadata_only/local_ref` without an artifact; the local player does not do a full read, so it is not limited by `VIDEO_INPUT_MAX_BYTES = 30MiB` and no extra copy is made for an over-limit local-ref. If the artifact exists but its derived path is unavailable, only the existing 512KiB chunks from the artifact may be used; it must not fall back to the original path.
- Web, mobile `web-remote-replayable` and SSH/WSL/Docker workspaces receive no server path and keep the attached host's chunked query, 30MiB preview limit and cancel semantics. Desktop main only provides a Range-capable local media protocol mapping, keeps no session/task/replay state and starts no runtime. After the Agent authorizes by row/index and selects a local path, the Host must first ask Main to add its `realpath` to a process-lifetime exact path set; the renderer may then play only that canonical path; the media protocol must not allow a path just because a URL carries an arbitrary absolute path or claims `video/*`. A path authorization failure shows the existing preview error and does not fall back to chunks.

## 3. Provider request projection (base64-only)

- `ModelVideoContentBlock` carries only `dataUrl`; neither the contract nor the strict JSON Schema offers URL/file-id fields.
- The openai-compatible patch always encodes video bytes as a base64 data URL in `video_url.url`.
- The anthropic patch always encodes video bytes as `source:{type:"base64"}`.
- Provider Files API, URL references, upload cache and invalidation strategy are not part of the current design; if the need returns, the spec and cross-provider recovery tests must be updated before implementing.

## 4. Key decisions

| Decision              | Conclusion                                                                                                                                                  | Basis                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Content form          | Phase 1 is base64 (dataUrl) only                                                                                                                            | User decision; isomorphic to the image pipeline; no upload infrastructure dependency                              |
| Video limit           | ZCode-wide fixed 30MiB, not in model catalog/session capability                                                                                             | Same as image: the model declares only whether it supports the modality, product policy sets input size uniformly |
| Web/mobile transport  | Keep the existing V4 20MiB attachment limit                                                                                                                 | Large-video transport is deferred; chunk/staging resource bounds are not widened                                  |
| Wire coverage         | openai `video_url` + anthropic `video` block, conversion layer generic on apiFormat, no endpoint specialization                                             | User decision                                                                                                     |
| Modality exclusivity  | Not handled in phase 1 (GLM explicitly "does not support understanding files, video and images together"); mixed attachments pass through the gateway error | User decision                                                                                                     |
| audio                 | Out of this phase                                                                                                                                           | User decision                                                                                                     |
| video in tool results | All provider kinds uniformly split into a trailing user part (reusing tool-result-media-projection)                                                         | The AI SDK tool result part has no video variant; smallest patch surface                                          |
| Budget                | Video gets its own budget bucket (default 30MiB), the image 4MB bucket is untouched (historical, see note at top)                                           | A 4MB bucket cannot hold video; merging would hurt images                                                         |

## 5. Implementation summary (phases 1-4)

### Phase 1 types and capability chain

- contracts: `ModelVideoContentBlock` + union + text projection; `media-policy` gains `supportsVideo` and a global video input limit constant; `ModelProperties`/`ModelCapability` gain `supportsVideo`; `ReadVideoOutput` + schema + `READ_VIDEO_MAX_INPUT_BYTES`.
- shared: `PROTOCOL_MEDIA_INPUT_MODALITIES` gains video + `supportsVideo` projection + zod schema field; `ZCodePromptVideoAttachment`; V4 keeps the existing 20MiB upload bound.
- core: `TurnAttachment.type` gains `"video"`.

### Phase 2 core chain

`attachments.ts` video branch (30MiB check, no compression, artifact persistence, over-limit degrades to path reference); `inferAttachmentMimeFromPath` gains video extensions; `conversation.ts` append; `media-capability` strip; `media-budget` video bucket; hydrator replay; `read-video.ts` + Read prompt update; runtime methods pass-through; bootstrap `mapProtocolPromptAttachment`/`attachment-refs` video branch; `prompt-command.ts` `VIDEO_EXTENSIONS`.

### Phase 3 adapter + two patches

- patch `@ai-sdk/openai-compatible`: file part gains `video/*` -> `video_url`.
- patch `@ai-sdk/anthropic`: file part gains `video/*` -> `video` block (isomorphic to the image branch).
- `transform.ts` video case (user/assistant degradation); `tool-result-media-projection` trailing video part; `model.ts` validation; `runner-options`/`registry` pass-through; `models-dev.ts` modality derivation.
- Adapter effective capability: model declaration and provider wire capability intersect; OpenAI Responses is explicitly downgraded to unsupported.

Close-out items of this round:

- The strict JSON Schema accepts `ModelVideoContentBlock` and keeps rejecting unknown fields.
- Catalog/provider override merge keeps and allows overriding `supportsVideo`.
- `FileSystemPort.readBinaryFile(maxBytes)` stays bounded at the actual read stage so a file growing between stat and read cannot bypass the limit; local video attachments reuse this entry. It declares EOF only on reading `0` bytes; a single short read continues from the current position so legitimate media is not truncated and reported as success.
- Read returns a stable error for a zero-byte video instead of generating empty media the adapter would drop.
- Inline video accepts only a strict base64 data URL with a `video/*` MIME; a missing base64 marker, invalid body or MIME mismatch uniformly becomes `attachment_video_invalid` and must not fall into the generic text attachment branch.
- Pure-media results from Read/tools snapshot the full data-backed block to an artifact and keep the reference in the completed tool part's `attachments`; cold resume re-projects for the current model/provider.
- Media capability and model I/O summaries gain video counts without changing message projection results.
- Web/mobile shared-host, `replayable`/`continuous` delivery boundaries and the existing 20MiB V4 upload resource limit stay as they were; Web inline video returns a structured over-limit error before base64 encoding at that limit; no new upload channel, chunk/staging expansion or independent runtime.

### Phase 4 UI

- `chatAttachments.ts`: mime inference + serialize video branch (desktop local path 30MiB; Web inline bound by the V4 20MiB limit).
- The composer and sent image/video share the media preview Dialog; video uses native controls/playsInline; a load or decode failure only changes the preview hint; sent attachments prefer the persisted artifact; i18n; both themes.

## 6. Tests and verification

- Unit tests first: `model-transform.test.ts` (video case/strip/unsupported), `model-transform-tool-media.test.ts` (trailing video part, both providerKinds), new `video-wire.test.ts` (mock fetch asserting both base64 wire shapes), `prompt-attachments.test.ts` (resolve/degrade), `media-budget.test.ts` (bucket), read tool, `chatAttachments.test.ts` (serialize/restore), filesystem short read, completed tool media cold resume.
- `media-capability.test.ts`, artifact-store and bootstrap persistence tests pin image behavior as unchanged and cover user video keeping the request-local path under `true`, `undefined`, `false`, plus inline video cold rebuild.
- `pnpm typecheck` + `pnpm lint` must pass.
- Manual end-to-end: desktop drag mp4 -> GLM-5V-Turbo (openai endpoint + one anthropic-compatible endpoint); Read mp4; history replay; small video on Web.
- E2E: first pin the representative switch/cold-resume combinations for composer video and Read video in the conversation case catalog/matrix; concrete pending specs are written after pruning is confirmed and use case-local fixtures.

## 7. Risks

| Risk                                            | Description                                                                                                             | Mitigation                                                                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| anthropic-compatible endpoint video acceptance  | The official Anthropic API has no video block; whether the consensus shape is accepted by each endpoint is undocumented | Generic conversion layer; converge `supportsVideo` after testing, strip placeholder when unsupported                          |
| 30MiB base64 request body (dataUrl about 40MiB) | May hit a gateway single-field inbound limit (same lesson as ZCT-2085774)                                               | Test; if adjustment is needed update global product policy and spec first; streaming/reference upload needs a separate design |
| Large video on Web                              | The existing V4 upload transaction limit is 20MiB and cannot carry the global 30MiB video input limit                   | No protocol resource expansion this phase; if needed, update the spec and design a transport                                  |
| Two-patch maintenance cost                      | AI SDK package upgrades need re-patching                                                                                | This spec §3 + the `patches/` directory record the patch content                                                              |
| Modality exclusivity not handled                | Mixed attachments pass the gateway error through                                                                        | Error text passes through (user confirmed)                                                                                    |
| OpenAI Responses rejects video file parts       | The AI SDK throws unsupported before the network request; catalog capability cannot represent wire capability           | Effective capability explicitly downgrades; the `openai-compatible` Chat Completions path is unaffected                       |
