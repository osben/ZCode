# E2E SSE Capture And Replay

Goal: external model APIs in desktop E2E must be recordable first and replayable in a fully isolated environment with streaming semantics. Ordinary JSON responses may keep replaying as full bodies; `text/event-stream` must keep SSE event order and relative timing.

## Artifact protocol

Network capture records keep going into `E2ENetworkCaptureArtifact.records`. For an SSE response a record additionally contains:

```json
{
  "responseEvents": [
    {
      "sequence": 0,
      "offsetMs": 0,
      "byteLength": 356,
      "text": "event: message_start\ndata: {...}\n\n"
    }
  ]
}
```

- `sequence`: SSE event order within one response.
- `offsetMs`: time from the first SSE response data to the moment this event is completely available.
- `byteLength`: UTF-8 byte count of the event.
- `text`: full SSE event text including the trailing blank-line separator.

The capture layer parses by SSE event separator, not by TCP chunk: chunk boundaries are unstable, and product semantics care about the order and rhythm of events such as `message_start`, `content_block_delta`, `message_stop`.

## Fixture protocol

The `response` of a replay fixture supports two shapes:

```json
{
  "response": {
    "statusCode": 200,
    "headers": { "content-type": "text/event-stream; charset=utf-8" },
    "closeMode": "end",
    "events": [{ "sequence": 0, "offsetMs": 0, "byteLength": 100, "text": "event: ...\n\n" }],
    "body": "event: ...\n\n"
  }
}
```

- With `events`, the replay server writes the response in segments by `offsetMs` and sets no `content-length`.
- Without `events`, the old behavior is kept: `body` is written at once.
- `body` may stay for manual inspection and old-tool compatibility, but automation should prefer `events`.
- `closeMode` matters only for `events` streaming replay. Default `end` means normal EOF; `destroy` destroys the socket after writing the declared events, to build an abnormal SSE mid-stream disconnect. The network artifact of a `destroy` run marks that record `status="error"` and writes `replay.closeMode="destroy"`.

The fixture top level also supports an optional `maxMatches`:

```json
{
  "id": "upstream-auto-compact-retry-empty-1",
  "maxMatches": 1,
  "match": {
    "bodyIncludes": ["CRITICAL: Respond with TEXT ONLY"]
  }
}
```

`maxMatches` only affects the local replay server's matching order, to express "the first N requests of a kind return A, then later fixtures return B". For example auto-compact retry makes the first two summary requests return empty text and the third a successful summary. It is not a product protocol field and never goes into online requests.

The replay server also writes the matched fixture into the capture artifact:

```json
{
  "replay": {
    "fixtureId": "upstream-sse-disconnect-after-delta",
    "closeMode": "destroy"
  }
}
```

It is for debugging fixture match order and fault-injection type, not an online capture field.

## Run modes

- `replay`: default; all DeepSeek requests hit the local replay server and use fixture responses. Suited to fully isolated Docker runs.
- `capture`: enabled by explicitly setting `E2E_PROVIDER_HTTP_MODE=capture`; a MITM proxy really accesses upstream and outputs an artifact with `responseEvents`. Recorded output is reviewed before being turned into fixtures.

## Docker replay

The container entry is `pnpm test:e2e:container`, driven by `scripts/test-desktop-e2e-container.sh`. The default network mode is `E2E_NETWORK_MODE=replay-isolated`:

```bash
E2E_NETWORK_MODE=replay-isolated \
E2E_SPEC=./test/e2e/conversation-session/manual-review/pending/conversation-session-compact.test.ts \
pnpm test:e2e:container
```

`replay-isolated` adds `--network none` to the test container and forces `E2E_PROVIDER_HTTP_MODE=replay`. WDIO, Electron, app, agent and the DeepSeek replay server then all run in one container and the external model API never leaves the network.

The DeepSeek capture/replay JSON is mounted under `network-capture/` of the run's report directory; the default file is `network-capture/upstream-provider.json`. It records the app's requests to DeepSeek, responses and the SSE `responseEvents` timeline, and serves as fixture review and later replay basis.

Modes:

- `E2E_NETWORK_MODE=replay-isolated`: default, offline replay, container loopback only.
- `E2E_NETWORK_MODE=bridge`: Docker default network, but DeepSeek is still replay by default.
- `E2E_NETWORK_MODE=capture`: controlled outbound recording; the script forces `E2E_PROVIDER_HTTP_MODE=capture` and requires a real `E2E_PROVIDER_API_KEY`.

Recording example:

```bash
E2E_NETWORK_MODE=capture \
E2E_PROVIDER_API_KEY=sk-... \
E2E_SPEC=./test/e2e/conversation-session/manual-review/pending/conversation-session-compact.test.ts \
pnpm test:e2e:container
```

`capture` output goes to `network-capture/upstream-provider.json` and is reviewed before becoming a fixture; CI and daily regression should use `replay-isolated`.
