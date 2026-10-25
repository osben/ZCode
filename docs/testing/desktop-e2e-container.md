# Desktop E2E Container Demo

This demo runs the desktop WebdriverIO Electron E2E in a Linux container. The default cases verify only the headless container baseline: Electron starts the main window on a virtual display and creates the default workspace.

## Run

```bash
pnpm run test:e2e:container
```

By default it runs a lightweight container smoke set:

- `packages/desktop/test/e2e/container-boot.test.ts`
- `packages/desktop/test/e2e/smoke.test.ts`
- `packages/desktop/test/e2e/e2ecase-regression.test.ts`
- `packages/desktop/test/e2e/upstream-provider.test.ts`
- `packages/desktop/test/e2e/task-list-archive-confirmation.test.ts`

The DeepSeek provider case uses fixture replay by default and never reaches the real upstream; a real key is required only with an explicit `E2E_PROVIDER_HTTP_MODE=capture`. The container path therefore covers the current core desktop e2e set, not just a boot demo.

After a run, a report and performance samples are written to `packages/desktop/.e2e-artifacts/<run-id>/`:

- `summary.md`: human-readable summary with case results, Electron process sampling summary and container resource summary
- `summary.json`: machine-readable summary
- `test-results.ndjson`: per-case results
- `perf/process-samples-*.ndjson`: CPU and memory samples of Electron main / renderer / GPU / utility processes
- `perf/container-samples.ndjson`: Docker CPU, memory, network IO and block IO samples

To view the HTML report, start the Vite viewer first:

```bash
pnpm dev:e2e-report
```

Then open `files.viewerUrl` from `summary.md` or `summary.json`.

The default sampling interval is 3 seconds; adjust the container interval with `PERF_SAMPLE_INTERVAL_SECONDS=5`. The Electron process interval is controlled by `ZCODE_E2E_PERF_SAMPLE_INTERVAL_MS`. To sample container and Electron curves at the same rate:

```bash
ZCODE_E2E_PERF_SAMPLE_INTERVAL_MS=1000 \
PERF_SAMPLE_INTERVAL_SECONDS=1 \
pnpm run test:e2e:container
```

Electron metrics are collected only after the WDIO Electron session is ready, so a short boot demo may have only start/end points; longer regression cases produce continuous CPU / memory trends.

## Override the spec

```bash
E2E_SPEC=./test/e2e/smoke.test.ts pnpm run test:e2e:container
```

## Conversation session suite

The conversation session uses its own Docker verified preset. The 38 current V4 formal cases do not yet have Docker `replay-isolated` evidence, so the verified set is empty; the command below exits with 2 before touching the Docker daemon and asks for per-case admission first:

```bash
pnpm run test:e2e:container:conversation
```

The preset can also be specified directly:

```bash
E2E_SPEC_PRESET=conversation-session-verified pnpm run test:e2e:container
```

The verified preset may only reference specs under `packages/desktop/test/e2e/conversation-session/` whose current code and fixtures passed Docker admission; it never references `manual-review/pending` and does not inherit legacy suite results. Admission rules: [conversation-session-docker-automation-plan.md](./conversation-session-docker-automation-plan.md). A new formal spec is first proven by a single-spec Docker replay:

```bash
E2E_SPEC=./test/e2e/conversation-session/<case>.test.ts \
  pnpm run test:e2e:container
```

After it passes, register it with the admission tool:

```bash
pnpm --filter @zcode/desktop e2e:docker:admit -- \
  --spec ./test/e2e/conversation-session/<case>.test.ts \
  --verified \
  --artifact packages/desktop/.e2e-artifacts/<run-id> \
  --apply
```

`smoke.test.ts` additionally verifies that the renderer reaches the interactive main workspace; if it fails, debug it as an ordinary desktop E2E problem and do not put a workaround into the business default path.

The first run downloads the Chromedriver matching Electron and caches it in a Docker volume. The default platform is `linux/amd64` and the default cache name is `zcode-desktop-e2e-driver-cache-linux-amd64`; later runs reuse the cache. To adjust:

```bash
DOCKER_PLATFORM=linux/amd64 \
DRIVER_CACHE_VOLUME=my-zcode-e2e-driver-cache \
DRIVER_PREFETCH_TIMEOUT=600 \
pnpm run test:e2e:container
```

The default script runs `docker build` each time so added or changed e2e cases are copied into the image; Docker reuses existing layer cache. When the image content is unchanged and you only want to rerun the same cases, skip the build:

```bash
SKIP_IMAGE_BUILD=1 \
pnpm run test:e2e:container
```

Do not skip the build after adding cases or changing test helpers, business source or dependency config; otherwise the container still runs the old image.

To fix the report directory:

```bash
ZCODE_E2E_RUN_ID=my-regression-run \
E2E_ARTIFACT_DIR=/tmp/zcode-e2e-report \
pnpm run test:e2e:container
```

The DeepSeek provider regression uses fixture replay by default and needs no real key:

```bash
E2E_SPEC=./test/e2e/upstream-provider.test.ts \
pnpm run test:e2e:container
```

To capture real GLM highspeed streaming data, switch explicitly to capture mode and pass the key:

```bash
E2E_PROVIDER_HTTP_MODE=capture \
E2E_PROVIDER_PRESET=glmhighspeed \
GLM_HIGHSPEED_E2E_API_KEY=... \
E2E_SPEC=./test/e2e/upstream-provider.test.ts \
pnpm run test:e2e:container
```

## Technical boundaries

- The image is based on `node:26.11.1-bookworm` and preinstalls the GTK, X11, fonts, DBus and `xvfb` dependencies Electron/Chromium needs on Linux.
- The launch script defaults to `linux/amd64` so Electron, the Chrome-for-Testing Chromedriver and the system dynamic linker share one architecture; on Apple Silicon Docker Desktop emulates the whole container.
- `packages/desktop/wdio.conf.ts` enables container parameters (WDIO Xvfb retry, Chromium test arguments) only when `ZCODE_E2E_CONTAINER=1`.
- Container mode pins the WDIO Chromedriver cache to `/workspace/.cache/wdio-browser-drivers`; the launch script reuses it through a Docker volume so each run does not depend on live network downloads.
- This demo does not verify the recovery semantics of mobile `/remote` (`web-remote-replayable`); remote control keeps using separate web/mobile regressions.
