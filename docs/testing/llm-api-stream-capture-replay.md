# LLM API Stream Capture Replay

## Background

Streaming performance problems cannot be reproduced from the final Markdown text alone. In the real
path, the number of provider SSE chunks, chunk intervals, agent/protocol merging, renderer IPC, UI
chunk batching, Markdown rendering and animation all affect CPU. Saving the complete response body
and replaying it at once changes the communication cadence and cannot reproduce renderer-layer
pressure reliably.

## Goals

- E2E capture keeps reaching the real provider through the local MITM proxy.
- The capture artifact keeps the request/response previews and also records the response chunk
  timeline.
- The replay server writes the response back as a stream following the chunk timeline, keeping the
  first-chunk delay and later chunk intervals.
- The default fixed replay behavior of the DeepSeek provider e2e is unchanged; performance sampling
  can override the prompt and replay fixture through environment variables.

## Non-goals

- No recording or replay of renderer IPC, ZCode Protocol events or UI store mutations.
- No real API key or auth header is written into artifacts.
- No cross-provider semantic parsing; this phase only preserves HTTP/SSE response cadence at the e2e
  network layer.

## Artifact extension

`E2ENetworkCaptureRecord` has optional fields:

- `responseChunkTimeline`: list of response body chunks.
- `responseChunkTimelineTruncated`: `true` when the chunk timeline reached the local size limit.

Each chunk contains:

- `offsetMs`: millisecond offset from the request entering the capture proxy to the chunk arriving
  at the proxy.
- `byteLength`: raw chunk byte count.
- `base64`: the chunk bytes recorded in the artifact.

`responseTextPreview` stays for manual inspection and existing usage parsing; performance replay
prefers `responseChunkTimeline`.

## Replay semantics

When the replay fixture has `response.chunks`:

- The replay server does not write `content-length`, so Node sends a chunked response as a stream.
- The first chunk is written after waiting its `offsetMs`.
- Later chunks are written after waiting the difference between adjacent `offsetMs` values.
- `response.body` stays as the complete response text for reports and old assertions.

Old fixtures without `response.chunks` keep returning `response.body` at once.

## Usage

Capture a real GLM highspeed response:

```bash
E2E_PROVIDER_HTTP_MODE=capture \
E2E_PROVIDER_PRESET=glmhighspeed \
GLM_HIGHSPEED_E2E_API_KEY=... \
E2E_PROVIDER_PROMPT='输出一篇很长的 Markdown，末尾包含 PERF_TRACE_DONE' \
E2E_PROVIDER_EXPECT_REPLY_TEXT=PERF_TRACE_DONE \
pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/upstream-provider.test.ts
```

(The prompt reads "Output a very long Markdown article that contains PERF_TRACE_DONE at the end".)

The `glmhighspeed` preset uses the Anthropic-compatible endpoint
`https://open.bigmodel.cn/api/anthropic` and model `glm-5.1-highspeed`. Capture mode defaults to
DeepSeek v4 flash when no provider preset is given; it switches to GLM highspeed only when
`E2E_PROVIDER_PRESET=glmhighspeed` / `LLM_E2E_PROVIDER_PRESET=glmhighspeed` is set explicitly. The
GLM highspeed preset does not force a thinking depth by default; override with
`E2E_PROVIDER_THOUGHT_LEVEL`.

The capture artifact is written by default to:

```text
packages/desktop/.e2e-home/.zcode/e2e-network-capture/upstream-provider.json
```

Replay a custom or capture-derived fixture:

```bash
E2E_PROVIDER_PRESET=glmhighspeed \
E2E_PROVIDER_REPLAY_FIXTURE_PATH=/absolute/path/to/replay-fixture-or-capture.json \
pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/upstream-provider.test.ts
```

## Risks and boundaries

- Response chunk timing is a network-layer observation and does not represent provider-internal
  token generation time.
- A capture artifact may contain a large response body; it stays in the local e2e artifact directory
  and is not committed.
- If the response exceeds the chunk timeline limit, the artifact is marked truncated; such records
  cannot be used for complete streaming replay.
