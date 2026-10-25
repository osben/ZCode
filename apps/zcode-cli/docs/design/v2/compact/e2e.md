# Compact E2E Harness

## Goal

Compact needs a set of manually runnable, schedulable E2E tests proving it holds not only in a
mock runtime, but across the real provider adapter, tool loop, message projection, compact
boundary and session event chain.

These E2E tests are not in the default `npm test`: real-model cases need external network, a real
API key and model cost. Default CI keeps running mock/unit/integration; real-model E2E is
triggered manually by developers, nightly or before releases. Error paths that cannot be reliably
induced with a real provider use a local scripted OpenAI-compatible provider inside Docker, still
going through the real ZCode app, provider adapter and runtime chain.

Real-provider cases start an OpenAI-compatible capture proxy in the same process. The provider
`baseURL` in ZCode's temporary config points at `127.0.0.1` inside the container; the proxy
records request/response payloads and forwards to the real upstream. Scripted-provider cases have
the container's HTTP server generate OpenAI-compatible responses and record the same capture
shape. Capture capability ships with the Docker E2E itself — no host-installed Proxyman,
mitmproxy or tcpdump.

## Case Matrix

### microcompact

The fixture builds a temporary workspace containing Node emitter scripts. The runner uses
`deepseek/deepseek-v4-flash` and prompts the model to call `Bash` twice:

- `node scripts/emit-alpha.mjs`
- `node scripts/emit-beta.mjs`

Both scripts write a temporary marker file and print large stdout with different sentinels. This
is closer than a plain `Read` to a real coding agent's read/write tool pressure in Docker,
without modifying the repository itself.

The runtime enables local microcompact via test injection:

- `microcompact.enabled = true`
- `thresholdTokens = 1`
- `keepRecentToolResults = 1`
- `compactableToolNames = ["Bash"]`
- a higher full auto compact threshold, so the E2E does not mix in summary compaction

Acceptance:

- The capture records at least one provider `/chat/completions` request.
- At least two `ToolCallResult`s happen.
- At least one `microcompact_boundary` happens.
- No full `compact_boundary` happens.
- The last `model_request`'s context contains the microcompact placeholder.
- The last `model_request` keeps the raw sentinel of only the more recent of the two Bash
  results.
- The final assistant response contains the fixed completion marker.

### manual-full-compact

The real model runs two normal text turns, then `/compact`, then one more conversation turn. The
point is not verbatim summary checking but the structured boundary of full compact:

- A `compact_boundary` is produced.
- `trigger = manual`, `phase = standalone_turn`.
- The summary model request has `querySource = compact`, `toolCount = 0`.
- The user's custom compact instructions reach the summary request.
- The next post-compact provider-visible context contains the post-compact continuation summary.

### auto-full-compact

The real model runs one large-stdout `Bash`; the runtime sets a very low auto compact threshold
and disables microcompact, ensuring full compact fires before the next model step after the tool
result returns. Acceptance:

- At least one `ToolCallResult`.
- A `compact_boundary` is produced.
- `trigger = auto`, `phase = mid_turn`.
- The final response contains the fixed completion marker.

### compact-ptl-retry

The Docker scripted provider returns an OpenAI-compatible `context_length_exceeded` on the first
compact summary request and a summary on the second. Acceptance:

- The compact request appears at least twice.
- The second request carries `compactPromptTooLongRetry = 1`.
- The capture shows both a 400 and a 200 for the same compact case.
- A standard `compact_boundary` is still produced.

### reactive-compact

The Docker scripted provider returns `context_length_exceeded` on a normal turn's main request;
the runtime triggers reactive compact and replays the request. Acceptance:

- A `compact_boundary` is produced.
- `trigger = reactive`, `phase = reactive`, `compactReason = provider_overflow`.
- The capture contains the main request's 400 overflow.
- After retry the final response contains the fixed completion marker.

## Artifact layout

Scheduled jobs use the top-level `result.json` as the machine decision entry:

```text
result.json
capture.json
events.json
cases/
  microcompact/
    capture.json
    events.json
    result.json
  manual-full-compact/
    capture.json
    events.json
    result.json
  ...
```

The top-level `result.json` holds only suite/case summaries; each case's full provider capture
and runtime events live under `cases/<case>/`. The top-level `capture.json` and `events.json` are
index files so scheduled jobs can discover each case's log paths when uploading or archiving.

## Planned items not yet in passing E2E

`session memory compact`, `partial compact` and automatic recent-file recovery after compact are
still explicitly future capabilities in the plan and must not be disguised as passing scheduled
cases. The current scheduled suite covers only the first implemented batch: manual full compact,
auto compact, PTL retry, reactive compact and provider-neutral local microcompact. When those
capabilities land, extend this spec first, then add passing E2E.

## Config boundaries

The E2E uses the existing `ZCODE_API_KEY` as the API key fallback and adds no new `ZCODE_`
environment variables. The DeepSeek base URL and model id default in the runner/config fixture
and can be overridden via runner CLI arguments; those overrides affect only the E2E process and
never enter product config. Scripted-provider cases use a temporary fake provider config with
`apiKeyRequired = false` and read no real API key.

The Docker runner uses the repository root as build context and runs `pnpm install`, `pnpm build`
and the E2E runner in the container. The default base image is `node:26.11.1-alpine`; it can be
overridden to a local or enterprise mirror via Docker build args, and the npm registry is
overridden the same way — no new product environment variables. The `@mbears` scope always falls
back to the official npm registry so generic mirrors lacking scoped packages still work. The
image may install system CAs with `INSTALL_CA_CERTIFICATES=true`; if the current network or
provider needs an extra host-trusted root certificate, mount the CA file through Node's standard
`NODE_EXTRA_CA_CERTS` instead of disabling TLS verification. The container receives only the
necessary API keys and never mounts the user home directory or global ZCode config.
