# CUA Final Image and Pixel Coordinate Integrity Contract

Status: implementation contract

Frozen baseline: `3ee0eadbe3dfda41a65bf2ac1a0d4ab761311060` (`origin/feat/cua-merge`)

Upstream design: Feishu `O3s2dIIooo1uuExdipOcVJ9Vnvg`, revision 75 (V3).

Producer implementation: workspace package `packages/zcode-cua` (import baseline
`zcode-cua@4a3c507dd16f3ed840e87bc92e709ce339e6a4f3`; includes image-first, transport-internal frame binding and
raster-only recovery guidance).

The revision also covers the 0.5.7 producer surface simplification, final raster/Zoom authority, WindowServer
screenshot click, window-event Ghost Cursor feedback, the Helper rename, `PERMISSION_REQUIRED` authorization
guidance and the 0.5.8 CUA target-app display metadata. Do not regress to any forked SHA.

## Goal

After the official CUA hands an image to the model, the model returns only:

```json
{ "type": "coordinate", "x": 496, "y": 331 }
```

`x/y` are integer pixels of the exact image the model received. The model does not choose Retina, DPI, logical
points, physical pixels, crop, scaling, window origin or display coordinate system; `@zcode/zcode-cua` and the
Helper handle all those differences internally.

The constraint defines only the path where the model picks a point from an image. When the model uses the
accessibility tree `state_id/index` directly it may still pass an element target; an element target carries no
image coordinate and must not substitute for image-point encoding. The two paths stay explicit in the public
schema.

## Cross-process sequence

```text
Helper capture
    │ raw raster + capture/pointer/topology provenance
    ▼
zcode-cua final crop/resize/encode
    │ register immutable internal frame; return image + image_ref + hint
    ▼
ZCode MCP bridge
    │ official CUA image must keep bytes, size, orientation and block adjacency
    ▼
model provider request
    │ model picks only integer x/y from the received raster
    ▼
zcode-cua transport synchronously binds current frame → registry → pixel-center projection
    → Helper second provenance check → native input
```

If any layer cannot prove this chain, the coordinate action must be rejected; never fall back to `screen`,
`normalized`, `state_image`, `screenshot` or "latest image" inference.

## Last-mile constraints

The generic MCP bridge omits, artifactizes or source-specifically compresses images over the inline budget.
That is reasonable for ordinary MCP but breaks the coordinate contract for an official CUA raster with an
issued `frame_id`: the image the model sees may no longer be the one the descriptor points to.

The official CUA therefore has an independent integrity gate:

1. The raster must be the first block of the tool result, with the `image_ref` text block immediately after;
   the bridge must not place any diagnostic/hook text before the raster, nor reorder or split the atomic pair.
2. zcode-cua already encodes the raster within a 190 KiB budget; ZCode must not resize, crop, rotate,
   re-encode it again or replace it with artifact text.
3. If the raster still exceeds an explicit provider limit, the whole result fails closed; keeping only
   `image_ref` and allowing actions on that frame is not allowed.
4. Each result allows exactly one final raster; the image bytes of the model-visible block stay as is, and
   MIME and width/height must match `image_ref`. The producer's internal byte digest for frame issuance does
   not extend the public `image_ref`; the bridge proves the last mile by unchanged original bytes plus an
   independent raster header check. The verification boundary is declared honestly: byte/shape checks happen in
   the MCP bridge (inbound) and executor attestation (outbound, fail-closed); downstream provider projection
   does not re-verify attestation but relies on the generic "adjacent paired text" structural rule (deferred
   media projection, media budget, compression placeholder) so `image_ref` and the raster reach the model
   adjacent or are removed together.
5. The special path is enabled only when an unforgeable official CUA authority gate holds; a same-named
   third-party MCP gets no exemption. The Host marks this authority only with
   `modelContentProtection=official_cua_frame_v1`; do not keep a second preserve boolean that must be set in
   sync. Structured media without this protection always uses the generic budget.
6. A `PostToolUse` hook may only append bounded text after the protected media pair; it must not replace,
   reorder, delete or insert content between the image and `image_ref`.
7. If any reference, MIME, base64, file header, size, budget or duplicate `frame_id` check fails, the bridge
   must atomically remove all CUA image/image_ref from the result and mark the result as an error; a partial
   media set is never sent to the model.
8. `structuredContent` must not contain a real JSON `image_ref` authority; the authority belongs only to the
   content block adjacent to the raster, which binds the image the model actually received. When the producer
   derives `structuredContent` (for example the AX text for `nodeRepl.write(state.text)`) it must exclude the
   authority block; otherwise the same authority appears in two places and rule 7 would reject every
   observation that carries a screenshot.
9. The rejection surface has two separate paths that must not be merged: the model gets only a generic
   "take a new screenshot" sentence with no `frame_id` and no on-disk path (a rejected frame must not become
   usable authority); the concrete criterion goes into the result `_meta` under
   `zcode.cua/frame-integrity-rejections-v1`. The host `formatMcpToolResult` reads one specific `_meta` key and
   never serializes `_meta` wholesale, so the criterion is diagnosable without entering model context. The
   criterion must not exist only in a function-local variable: on 2026-09-11 real hardware rule 8 was violated,
   the criterion was discarded after rejection, and a whole-channel failure ("every screenshot observation
   vetoed by its own gate") stayed silent for a full day.

## Helper provenance contract

The Helper must explicitly declare `frame_pixel_projection_v1`, and capture returns the authoritative fields for
building the FrameDescriptor: captured raster size/crop, pointer rect/unit, app owner, window_id/bounds,
display identity and topology fingerprint.

The action RPC carries the projected point and the capture-time provenance. Before native input the Helper
re-reads the current owner/window/display/topology; on mismatch it returns `stale_frame` with
`actuated=false`. An old Helper, missing fields, Wayland, or an X11 environment that cannot prove a 1:1 root
grid rejects only the frame coordinate; the element/AX path stays available.

## Acceptance

- Official CUA small images and images near/over the generic 200 KiB threshold keep the raster unchanged.
- An adjacent `image_ref` and image block remain adjacent after the MCP bridge.
- Non-official MCP still follows the generic inline/artifact budget.
- `returnedBytes` is the only aggregate of model-visible text and real raster payload; do not expose or depend
  on a second `mediaBytes` state. An appended hook adds only its actually added UTF-8 bytes to the existing
  aggregate.
- Missing capture capability/provenance means zero actuation for coordinate actions.
- macOS Retina, Windows DPI-aware physical pixels and the provable Linux X11 range have marker-grid evidence;
  Wayland and ambiguous X11 fail closed.
- `pnpm typecheck`, `pnpm lint` and related package tests are green.
- The producer pin must pass the frame-contract export and implementation-existence gate, and the candidate
  provenance records the merge relation of the minimum baseline; matching version numbers without the pixel
  contract must be judged a packaging failure.
