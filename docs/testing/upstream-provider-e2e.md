# Upstream provider E2E

`packages/desktop/test/e2e/upstream-provider.test.ts` is the fixed regression case for the E2E upstream provider. The provider's address, API key and model name are all controlled by environment variables; the repository hard-codes no provider.

The case writes the E2E provider through the desktop settings page, adds the main model, returns to the workspace, selects that model and sends a request. The default mode does not touch the real network: it starts a local fixture replay server that replays previously captured real responses as HTTP content, so the fixed case reproduces stably.

## Environment variables

| Variable                       | Purpose                                                                                    | When unset                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `E2E_PROVIDER_BASE_URL`        | Upstream provider address                                                                  | Error in capture mode; not needed for replay                |
| `E2E_PROVIDER_API_KEY`         | Upstream API key                                                                           | Error in capture mode; replay always uses `e2e-fixture-key` |
| `E2E_PROVIDER_MODEL`           | Main model name                                                                            | The replay fixture's recorded model                         |
| `E2E_PROVIDER_SECONDARY_MODEL` | Second model name (model switching, fallback provider and similar cases)                   | The replay fixture's recorded model                         |
| `E2E_PROVIDER_PRESET`          | `env` (default, the four variables above) / `glmhighspeed` / `bigmodel53` / `stagingmodel` | `env`                                                       |

- The recorded model is defined once in `packages/desktop/test/e2e/helpers/upstream-recorded-models.ts`. Built-in product model rules match thinking levels and request shape by model ID and the fixture is captured for the recorded model, so changing the default model requires re-recording the fixture.
- `E2E_PROVIDER_RUNTIME_BASE_URL` is the effective address WDIO writes to each test process (it points at the local replay server during replay); do not set it manually.
- Cases such as "add provider template" in the settings page verify the product's built-in templates (including DeepSeek) and are not E2E provider configuration.

## Default fixed replay

Run the spec directly:

```bash
pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/upstream-provider.test.ts
```

Default replay behavior:

- WDIO starts a local replay server and points the E2E provider address at it.
- The API key is forced to `e2e-fixture-key`; the local real key is never read or leaked.
- Fixed responses come from `packages/desktop/test/e2e/fixtures/upstream/provider-basic.json`.
- WDIO pre-seeds the main and second model in the isolated HOME; the new-session state-isolation case reuses this fixture so the provider settings page "add model" is not a precondition of session-area tests.
- The request capture artifact is written to `packages/desktop/.e2e-home/.zcode/e2e-network-capture/upstream-provider.json`; auth headers and token fields are redacted.
- The case checks the UI, the request body, the thinking-depth field, and that context consumption equals the usage of the real response in the fixture.

This case is "capture once, replay fixed": fixture content comes from a real upstream request, but default execution no longer depends on account balance, upstream rate limits or live model availability.

## Capturing real data

To refresh the fixture, switch explicitly to capture mode and give the upstream address, key and model via environment variables. When refreshing the existing fixture the model must match the recorded model:

```bash
E2E_PROVIDER_HTTP_MODE=capture \
E2E_PROVIDER_BASE_URL=https://<provider-host>/anthropic \
E2E_PROVIDER_API_KEY=... \
E2E_PROVIDER_MODEL=<model-id> \
pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/upstream-provider.test.ts
```

Capture mode starts a transparent MITM capture proxy on the local machine:

- The provider endpoint stays the real address; the `glmhighspeed` preset is recommended for performance samples.
- The proxy only forwards and captures; it never synthesizes model responses.
- The CA is generated only under `packages/desktop/.e2e-home/.zcode/e2e-network-capture/ca` and never written to the system certificate store.
- WDIO injects `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` into the e2e process tree.
- The capture artifact is written to `packages/desktop/.e2e-home/.zcode/e2e-network-capture/upstream-provider.json`.
- The artifact also records `responseChunkTimeline` (relative time and bytes of response chunks) to replay the real SSE cadence later.

After capture, organize the redacted responses into a single-case fixture. The fixed case never depends on the latest live response; dynamic network regressions need a separate name and explicit runs.

## Capturing long streaming performance samples

Default replay still uses the fixture recorded in the repository so the fixed provider regression never touches the real network. To record a long Markdown streaming performance sample, set `E2E_PROVIDER_PRESET=glmhighspeed` explicitly. This preset uses `https://open.bigmodel.cn/api/anthropic` and model `glm-5.1-highspeed`. The GLM highspeed preset does not select a thinking depth by default and does not assert the thinking field; recorded-fixture replay and the `env` preset select and assert `high` by default.

```bash
E2E_PROVIDER_HTTP_MODE=capture \
E2E_PROVIDER_PRESET=glmhighspeed \
GLM_HIGHSPEED_E2E_API_KEY=... \
E2E_PROVIDER_PROMPT='输出一篇很长的 Markdown，包含多级标题、列表和代码块，末尾写 PERF_TRACE_DONE' \
E2E_PROVIDER_EXPECT_REPLY_TEXT=PERF_TRACE_DONE \
pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/upstream-provider.test.ts
```

Replay a custom fixture or capture artifact later:

```bash
E2E_PROVIDER_PRESET=glmhighspeed \
E2E_PROVIDER_REPLAY_FIXTURE_PATH=/absolute/path/to/upstream-provider.json \
pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/upstream-provider.test.ts
```

When the replay fixture carries `response.chunks`, or a capture artifact containing `responseChunkTimeline` is used directly, the local replay server streams the response back at the original chunk offsets instead of returning the whole body at once.

## Local configuration

Only capture mode and the real provider smoke need a real address and key; the repository provides no default. WDIO reads `packages/desktop/.env.e2e.local` then the root `.env.e2e.local` in order; values passed explicitly in the shell take precedence. The root `.env.e2e.local.example` lists variable names only with empty values and is not read as a fallback. Write them in a locally ignored file:

```bash
cp .env.e2e.local.example .env.e2e.local
```

Then fill in the address, key and model in `.env.e2e.local`. GLM highspeed recording reads `GLM_HIGHSPEED_E2E_API_KEY` first and also accepts `BIGMODEL_API_KEY` / `ZHIPUAI_API_KEY`.

`*.local` means machine-private config, suitable for long-lived personal API keys, and is ignored by `.gitignore`; never write a real key into a committable `.env.e2e`.
