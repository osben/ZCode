# Desktop E2E Reporting

Desktop E2E writes test reports to `packages/desktop/.e2e-artifacts/<run-id>/` by default. The directory holds test artifacts only and is in `.gitignore`.

## Run

Local:

```bash
ZCODE_E2E_SPEC=./test/e2e/e2ecase-regression.test.ts pnpm --filter @zcode/desktop test:e2e
```

Container:

```bash
pnpm run test:e2e:container
```

Environment variables:

- `ZCODE_E2E_RUN_ID`: fixes the report directory name
- `ZCODE_E2E_ARTIFACT_DIR`: sets the report output directory
- `ZCODE_E2E_REPORT_VIEWER_BASE_URL`: Vite viewer address used to build `files.viewerUrl`, default `http://127.0.0.1:4173/`
- `ZCODE_E2E_PERF_SAMPLE_INTERVAL_MS`: Electron process sampling interval, default 3000ms
- `PERF_SAMPLE_INTERVAL_SECONDS`: container `docker stats` sampling interval, default 3s
- `ZCODE_E2E_COVERAGE=1`: enables source coverage for the four runtime domains renderer / main / host / CLI

Electron process sampling calls `app.getAppMetrics()` through the WDIO Electron session, so the window starts after the session is ready; container sampling is started by the outer Docker script and covers image run and test startup. To align both curves set `ZCODE_E2E_PERF_SAMPLE_INTERVAL_MS=1000` and `PERF_SAMPLE_INTERVAL_SECONDS=1`. Very short cases may produce only start/end points; long regressions produce continuous trends.

## Artifacts

- `manifest.json`: environment, spec, sampling interval
- `test-results.ndjson`: per-case title, status, duration and error summary
- `summary.json`: machine-readable report summary
- `summary.md`: human-readable report summary
- `workers.ndjson`: cid/spec of workers that completed environment registration; fewer entries than `before-session` means the pre-registration transaction failed
- `lifecycle-events.ndjson`: prepare/worker/session/hook/complete durations; a failed event must record both `status=failed` and an error summary
- `perf/process-samples-*.ndjson`: main / renderer / GPU / utility process CPU and memory from Electron `app.getAppMetrics()`
- `perf/container-samples.ndjson`: in container mode, CPU, memory, network IO, block IO and PID count from `docker stats`
- `coverage/ui-renderer-istanbul-raw.json`: raw Istanbul data read from renderer `globalThis.__coverage__` when `ZCODE_E2E_COVERAGE=1`
- `coverage/ui-renderer-summary.json` / `coverage/ui-renderer-summary.md`: renderer UI source coverage summary
- `coverage/ui-renderer-html/index.html`: Istanbul HTML report (totals, per-file coverage, per-line hits)
- `coverage/lcov.info`: LCOV report for CI or other coverage tools
- `coverage/coverage-final.json` / `coverage/coverage-summary.json`: Istanbul JSON coverage data
- `coverage/summary.json`: four-domain totals, raw count, source file count and completeness
- `coverage/{main,host,cli}/`: JSON, LCOV and HTML reports per Node/Electron domain
- `coverage/heatmap/index.html`: four-layer function execution heatmap (renderer / main / host / CLI)
- `coverage/heatmap/data.json`: per-file function hit data used by the heatmap, reusable for trend or per-case analysis

## HTML report

The HTML report boundary is "read `summary.json` and render a view"; it never reads the WDIO runtime or business code. The viewer is the Vite app in `packages/e2e-report` using Chart.js; the desktop E2E runner only passes in the aggregated summary payload.

Start the viewer:

```bash
pnpm dev:e2e-report
```

After E2E finishes, `files.viewerUrl` in `summary.md` and `summary.json` gives an address with a `summary` parameter, for example:

```text
http://127.0.0.1:4173/?summary=%2F%40fs%2FUsers%2Fdev%2Fworkspace%2Fz-code%2Fpackages%2Fdesktop%2F.e2e-artifacts%2F...%2Fsummary.json
```

The page shows:

- run status, duration, pass rate and key resource metrics
- CPU trend: container CPU and Electron per-process-type CPU overlaid
- Memory trend: container memory and Electron per-process-type memory overlaid
- case details, spec, environment and artifact paths
- with `ZCODE_E2E_COVERAGE=1`: the renderer UI coverage overview, per-file summary and Istanbul HTML / LCOV / JSON entries

## Boundary

Implemented: the report skeleton, case results, container-level resource sampling, Electron process-level CPU/memory sampling and optional four-domain coverage sampling. All of it hangs on the E2E harness and the coverage-only build; it does not change the normal desktop startup path.

`summary.json` and global process/HOME cleanup are finalized authoritatively by WDIO `onComplete`. When the last worker ends, the runner must hold a referenced short-lived finalization guard until `onComplete` starts, so Node cannot silently exit 0 before the promise continuation runs. A normal `onComplete` releases the guard and writes the summary; a guard timeout is only an infrastructure-failure fallback: it must first write a failure summary from the existing NDJSON and then exit non-zero. An empty run without a summary must not count as success.

Renderer UI coverage is off by default and enabled only with `ZCODE_E2E_COVERAGE=1`:

```bash
ZCODE_E2E_COVERAGE=1 pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/conversation-session/conversation-session-running-actions.test.ts
```

To run formal and `manual-review` cases in one go and produce the four-domain report, use the repo entry:

```bash
pnpm test:e2e:all:coverage
```

The entry sets both `ZCODE_E2E_COVERAGE=1` and `ZCODE_E2E_MANUAL_REVIEW=1`. Each worker isolates its provider by its own spec: formal cases and pending cases that have a case-local fixture use replay; pending cases without a fixture and `upstream-provider.test.ts` use capture. One worker never mixes the two modes. The standalone real-provider smoke is included only when both `E2E_PROVIDER_BASE_URL` and a real `E2E_PROVIDER_API_KEY` (not the replay placeholder) are configured; otherwise the entry excludes that external smoke precisely and prints the reason, so a missing-key 401 is not reported as a product regression. When the SSH environment is complete, SSH cases are included; otherwise only the SSH cases are excluded and the rest run in full.

With `ZCODE_E2E_COVERAGE=1`, Vite inserts Istanbul instrumentation at build time. At the end of E2E the reporter connects to the real renderer target through WebdriverIO `browser.getPuppeteer()`, reads the counters from `globalThis.__coverage__` and generates standard Istanbul reports.

Instrumentation must happen in the source-level `pre` transform stage, generating Istanbul counters directly from the original `.ts` / `.tsx` AST. Do not switch back to a post-transform generic Vite Istanbul plugin: such plugins rely on merged Vite/React/esbuild sourcemaps to recover source positions, and were verified to map generated-JS coverage points onto non-runtime lines such as `import` and `interface`, which pollutes both per-line HTML and total coverage.

UI coverage source scope:

- `packages/ui/src`
- `packages/desktop/src/renderer`

The E2E summary and the e2e-report viewer show only the coverage overview, per-file summary and artifact entries; the professional per-line hit/miss view is `coverage/ui-renderer-html/index.html`. This layering avoids duplicating a full coverage UI in the run report and lets CI upload LCOV or Istanbul HTML directly.

## Cross-process source coverage contract

`ZCODE_E2E_COVERAGE=1` must collect four runtime domains in the same Desktop E2E run and report each separately:

- `renderer`: Istanbul source coverage of `packages/ui/src` and `packages/desktop/src/renderer`.
- `main`: first-party source coverage of Electron main and what is bundled into the main graph.
- `host`: first-party source coverage of the Electron utility host and what is bundled into the host graph.
- `cli`: first-party source coverage of the zcode-cli `app-server` started by desktop and what is bundled into the CLI graph.

Data flow:

```text
WDIO worker/session
  |-- renderer globalThis.__coverage__ ----------> raw/renderer/<worker>.json
  |-- Electron main NODE_V8_COVERAGE + flush ----> raw/main/<pid>.json
  |-- utility host NODE_V8_COVERAGE + flush ----> raw/host/<pid>.json
  `-- CLI app-server NODE_V8_COVERAGE ------------> raw/cli/<pid>.json
                                                      |
                                                      v
                                    source map remap + repo-relative normalize
                                                      |
                       independent standard Istanbul reports for renderer / main / host / cli
```

Collection and aggregation rules:

1. A worker, session and PID write only their own raw file; never overwrite another worker's data in the same run.
2. Suite aggregation runs only after all workers exit. The renderer uses an Istanbul coverage map union; Node/Electron domains use a V8 raw union, then c8 maps back to source. After each worker exits, Node raw may be trimmed in place to the target runtime domain and keep one source map per canonical bundle URL; when one domain has several lazy chunks, each distinct bundle still keeps its own map. Never delete a later chunk's only map because "the domain already has a map".
3. The coverage build must keep external source maps and must not minify the main, host, preload and CLI bundles; these maps exist only in the E2E build/cache/artifact and never enter the release package.
4. The E2E exit path of Electron main finally force-kills the process, so `node:v8.takeCoverage()` must be called explicitly before the kill; host flushes explicitly after resource release and before `process.exit`. In coverage mode the CLI app-server is first asked to exit normally via stdin EOF, with a longer wait window than the release package; the SIGTERM / `process.exit` path after timeout must also flush actively and leave a window for the V8 background write before the explicit exit. The CLI coverage preload writes a readiness marker before the first-party bundle runs: a marker without raw is a collection gap; a process that exits early without a marker has not run first-party entry code and is counted separately as pre-entry zero, not reported as incomplete.
5. Reports count only entries whose source map attributes to first-party repo code, excluding `node_modules`, tests, fixtures, declaration files and third-party/generated artifacts. main / host map to TypeScript sources; CLI-internal workspace packages currently ship no secondary sourcemap, so those packages use the `dist/*.js` the CLI bundle map provides as the finest source, while the CLI itself and shared packages still map to original sources. Once internal package sourcemaps exist, converge to TypeScript without changing the raw collection contract.
6. The four percentages are shown independently; different domains are never added into one total. Shared source may appear in several domains.
7. If any executed domain produced no raw data, the coverage status must be `incomplete`; the remaining data must not pose as complete coverage.

Each domain outputs the standard artifacts:

- `coverage/<domain>/coverage-final.json`
- `coverage/<domain>/coverage-summary.json`
- `coverage/<domain>/lcov.info`
- `coverage/<domain>/index.html`

## Function execution heatmap contract

Coverage percentage answers "was it executed"; the function heatmap answers "where is execution concentrated". The heatmap consumes only the four already-generated `coverage-final.json`; it must not restart the app or change E2E case semantics.

```text
renderer coverage-final.json ----\
main coverage-final.json ---------+--> per-file function-hit aggregation --> full flat tiling --> coverage/heatmap/
host coverage-final.json ---------+
cli coverage-final.json ----------/
```

Rules:

1. All source-file leaf nodes of a runtime domain are laid out at once in one canvas; one tile represents exactly one file. Directories exist only as part of file paths; they must not be aggregated into tiles, and users must not need to click through directories to compare hotspots.
2. All file tiles have equal width and height; area encodes no metric. Only brightness encodes the in-file function hit heat; brighter means more frequent execution. All tiles use one scale per runtime domain, not re-normalized per local directory.
3. The default color metric is the file's total function hit count, processed with a `log1p` log scale for orders of magnitude, then contrast-enhanced on the normalized result, so a few million-hit hotspots do not compress the rest into one dark color and all non-zero files do not look equally bright. The report may also switch to "average hits per function" to weaken the size effect where large files naturally accumulate more hits.
4. Files with no hits use a separate zero-hit color, not confusable with low-frequency but hit code. Besides color, the exact count, covered-function count and coverage must be shown; conclusions must not rely on visual brightness alone.
5. renderer / main / host / CLI switch independently and normalize color independently; call counts are never merged across domains. Shared source may appear in several domains.
6. Tile hover, keyboard focus or click only updates the selected detail and does not change canvas hierarchy. The detail includes at least the path, total function hits, covered function count, and the hottest function with its source line.
7. Heat is the cumulative run intensity of the whole E2E suite, not functional coverage breadth. High heat may come from one case's loop; low heat may still verify key states. When later split per case, also show the number of cases hitting a function and per-case P50/P95/max call counts.
8. The report must be a self-contained static file with no remote CDN or running viewer service, so it opens directly from a local machine or CI artifact.

The suite-level `coverage/summary.json` records the four-layer totals, raw file count, source file count and collection completeness. For the CLI, the exited Agent PIDs in the runtime log are used to look up readiness/raw PIDs; any CLI process that entered the first-party entry but has no raw records `missingRawProcessCount` and marks the domain incomplete, while early exit before the entry records `preEntryProcessCount`. In this first phase coverage is a diagnostic and trend metric with no pass-rate gate; whether functional state combinations are verified is still decided by the case catalog, the coverage matrix and each case's setup/action/assertion.
