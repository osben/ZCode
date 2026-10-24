# MCP Tool Output Budget

## Rules

MCP servers are external input; tool result size is not trusted by default. MCP text results stay
under `resultBudget`. Base64 image payloads over 200 KiB must not be inlined into model requests.
Host tool `node_repl/js` (browser-use trusted host tool) images are first compressed into budget;
other third-party MCP images are not compressed and fall back to artifacts. Oversized images that
cannot be compressed are saved as a local artifact copy; the model receives only the artifact
path/URI and dimensions. Without an artifact store, oversized images still must not be inlined and
degrade to a text note. `desktop-continuous` and `web-remote-replayable` session/task semantics are
unchanged: this is a tool-result projection inside the agent runtime.

## Design

Normalization happens in the MCP tool handler right after `McpPort.callTool`, not in
`formatModelContent`: the handler owns `artifactStore`, `sessionId`, `turnId`, `toolCallId` and can
persist a copy; `formatModelContent` only sees output and cannot write to disk.

Rules:

1. For `type: "image"` with valid `data` / `mimeType`, compute the UTF-8 byte size of the base64
   payload.
2. Payloads up to `200 * 1024` bytes stay inline.
3. Host images (`serverName=node_repl && toolName=js`) first go through
   `ImageProcessorPort.prepareForModel`:
   - base64 payload cap `200 * 1024` bytes;
   - decoded binary cap `floor(200 * 1024 * 3 / 4) = 153600` bytes, so re-encoding stays in budget;
   - max long edge 2000, matching readable `Read` model images;
   - reuse the adapter's existing candidate sequence (keep-format/PNG optimize, 2000-edge scale,
     JPEG quality ladder, PNG quantize, progressive downscale, low-quality small-JPEG fallback);
     MCP bridge must not add a second codec.
4. On successful compression, re-check actual base64 bytes `<= 200 KiB` and hand only the
   transformed `data` / `mimeType` to the model; the original image never enters the provider
   request.
5. Third-party MCP images get no CPU-heavy compression; they go straight to the artifact strategy,
   keeping untrusted MCP payloads out of the generic image-decode attack surface.
6. Host images with a missing `ImageProcessorPort`, decode/compress failure, or a failed defensive
   re-check fall back to the tool artifact path: prefer `writeToolResultBinaryArtifact` for the
   decoded binary with a `.png` / `.jpg` / `.gif` / `.webp` extension by `mimeType`; the model sees
   only the local path/URI.
7. The model-visible content block becomes text stating the MCP image was saved, the local
   path/URI, the original size and the threshold.
8. If the artifact store does not support binary writes, fall back to a text artifact: JSON with
   `dataUrl`, `mimeType`, server/tool names, original base64 byte count and creation time.
9. If no artifact store is available, replace with text stating no copy was saved; never send the
   large base64.

### Source and outcome matrix

| Source        | Original base64 | ImageProcessor       | Outcome                            | Status   |
| ------------- | --------------: | -------------------- | ---------------------------------- | -------- |
| `node_repl/js` | `<= 200 KiB`   | any                  | original inline                    | accepted |
| `node_repl/js` | `> 200 KiB`    | compressed in budget | compressed inline                  | accepted |
| `node_repl/js` | `> 200 KiB`    | missing/failed/over  | artifact or no-store text fallback | accepted |
| other MCP     | `<= 200 KiB`    | any                  | original inline                    | accepted |
| other MCP     | `> 200 KiB`     | any                  | artifact or no-store text fallback | accepted |

Only the agent tool-result projection changes: no new protocol fields, no session/task state change,
no divergence between `desktop-continuous` and `web-remote-replayable` — both share the same
budgeted tool result.

## Verification

- Small MCP images still project as image blocks.
- Large MCP images become text; with a binary artifact store the decoded bytes are saved and the
  image path/URI returned.
- Oversized `node_repl/js` PNG/JPEG compress to image blocks within 200 KiB base64 when
  `ImageProcessorPort` is available, without writing artifacts.
- Host images that fail compression or stay over budget are not inlined; the original is saved as an
  artifact.
- The real Jimp adapter covers both budgets (2000 long edge, 200 KiB base64) for long-page
  screenshot ratio PNGs.
- Legacy artifact stores fall back to JSON artifacts; the model request contains no original base64.
- Without an artifact store, large images still degrade to text and never enter the model request.
- Run the MCP bridge and runtime tool loop unit tests; run `pnpm typecheck` and `pnpm lint`.
