# ARMS Electron Monitoring

Only `@arms/rum-electron` is integrated, on the Electron desktop. The Web/mobile remote-control end is not
connected to the ARMS Browser SDK. The ARMS SDK is initialized at the main-process entry only, never in
`packages/ui`.

Reference: [Alibaba Cloud ARMS Electron integration documentation](https://www.alibabacloud.com/help/zh/arms/user-experience-monitoring/integrating-with-an-electron-application)

## Monitoring scope

ARMS covers Electron runtime user-experience monitoring:

- Global JS errors and Promise rejections (main process + Renderer via SDK auto-injection).
- XHR/fetch API success rate, failure rate, duration, status code.
- Renderer longTask / LoAF / rAF main-thread stall events; main-process `beforeReport` only adds a
  low-cardinality attribution summary, never the original script name or URL.
- Electron main-process exceptions, native crashes, application startup events (`application` collector).
- RPC calls (`rpc` collector; main-process tRPC must use `instrumentTRPC`).

ARMS does not cover Host/Agent business logs, the quality statistics database, `/report` business events or
Web remote-control RUM. Unexpected Agent exit is not collected by the SDK automatically: the Host lifecycle
bridge actively sends sanitized `perf_agent_crash` / `perf_agent_spawn_error` custom events.

## Console error collection boundary

The desktop main logger writes errors as `console.error(prefix, message, context)`, where `prefix` is the common
`[timestamp] [pid] [source]` prefix and `source` is `main`, `renderer`, etc. The ARMS Electron SDK console
collector must normalize multi-parameter calls at the collection boundary instead of treating only the first
parameter as `exception.message`:

```text
console.error(prefix, message, context/Error)
                    │
                    ▼
          ARMS console collector
          ├─ Error: keep name / message / stack
          └─ non-Error: drop the common prefix, then safely serialize the remaining arguments
                    │
                    ▼
         bounded, redacted exception.message
```

- When the arguments contain an `Error`, that object is reported first and its original stack is kept.
- For non-`Error` multi-argument calls, remove the first main-logger common prefix (`main` / `renderer` etc.),
  then concatenate strings and contexts in call order.
- Redact object keys and common token text; recursive references must not make the collector throw.
- The final message is at most 2000 characters; a call with only the common prefix and no business text
  produces no exception event.
- Controlled exits such as `clean-exit` / `killed` are lifecycle information and use `info`; recoverable
  exceptions use `warn`; only confirmed crash, OOM or startup failure uses `error`.

## Dependency patch constraints

The repository uses `node-linker=hoisted`; the ZCode patch is fixed against `@arms/rum-electron@0.0.3`. A
patch change must regenerate a complete unified diff in one go from that version's original `dist/index.mjs`;
never append hunks to the existing patch, otherwise later hunks' target line numbers and target blob hash
disagree with the full result and the second `pnpm install` under pnpm 10 re-applies the patch to an already
patched file and fails with `ERR_PNPM_PATCH_FAILED`. After changing the patch, verify that the patch head's
target blob matches the installed product and that two consecutive `pnpm install` runs in the same workspace
both succeed.

## Configuration (hardcoded)

| Item                       | Location / value                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint                   | `ZCODE_ARMS_RUM_ENDPOINT` (`packages/shared/src/env.ts`)                                                                                        |
| Upload environment         | `mapZCodeEnvToArmsRumEnv(runtimeEnv)`: local development runtime is always `local`; for non-local runtime only `ZCODE_ENV=production` is `prod` |
| `sessionConfig.sampleRate` | `1` (100% session sampling)                                                                                                                     |
| `autoInject`               | `true` (the SDK injects the Browser SDK at `dom-ready`; do not init manually in preload/renderer)                                               |
| `browserCollectors`        | `perf/webvitals/exception/whiteScreen/api/staticResource/click/longTask: true` (see `ARMS_BROWSER_COLLECTORS`)                                  |
| `spaMode`                  | `false` (Electron loads whole pages, not History SPA)                                                                                           |
| `parseViewName`            | `file://` uses the html filename; http dev-server uses the pathname                                                                             |
| `tracing`                  | `arms_env=prod`: `enable: true`, `sample: 0.1` (0.1%); `arms_env=local`: `sample: 1`                                                            |

No `ZCODE_ARMS_*` environment variables exist.

## longTask attribution summary

The Browser SDK `longTask` collector puts LoAF / rAF attribution into `snapshots`. To ease SLS queries and avoid
high cardinality and path leakage, main-process `appARMSBootstrap.beforeReport` puts only a top-attribution
summary into the same longTask's `properties`:

| Field                   | Meaning                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| `loaf_script_count`     | Number of attribution entries in `snapshots`, at most 5.         |
| `loaf_top_duration_ms`  | Duration of the top attribution in ms.                           |
| `loaf_top_invoker_type` | `user-callback` / `event-listener` / `script` / `unknown`.       |
| `loaf_top_share_pct`    | Top attribution as an integer percentage of longTask `duration`. |

This adds no events and does not change sampling; it is skipped when `snapshots` is missing or unparsable.
Original script name, URL, file path, selector, stack or source fragments must never be written to these
properties.

## Auto-Collected Event Redaction Boundary

Fields gathered by the SDK collectors are decided by ARMS and may contain UI text, native paths and full URLs.
`appARMSBootstrap.beforeReport` must redact the whole batch before events leave the machine, after the longTask
attribution summary and before returning the payload. Redaction rewrites only the reporting copy; local logs,
error rendering, crash archives and the aggregation of `perf_network_window` are unchanged (network aggregation
ingests before redaction and keeps the `normalizeHttpInterface` dimension rules).

### `click`

The Browser SDK `name` looks like `click on <type-><tag>: <first 20 chars of innerText>...` and `snapshots` is
JSON of `{id,name,className,href,src}`. ZCode clickable text includes conversation titles, workspace directory
names, filenames, message bodies and account emails, so:

- `name` keeps only `click on <type-><tag>`; the element text after `: ` is cut.
- `snapshots` is deleted (`href` / `src` may be local file paths; `id` / `className` have no diagnostic value).
- `target_name` (an XPath expressing structure only, no text) and non-content fields such as duration and view
  are kept.

### `exception`

`message` / `stack` / `file` / `snapshots` of `jsError` (`uncaughtException` / `unhandledRejection`),
`consoleError`, `whiteScreen` and renderer-side exceptions follow the unified text redaction rules: URLs keep
only `protocol//host` plus unified routing, absolute paths become `{path}`, emails `{email}`, credentials and
Authorization `{redacted}` / `{secret}`, with bounded truncation. The console redaction in the dependency patch
covers credential keywords only; paths and emails are closed by this section. `file` is the script URL the SDK
collects from `ErrorEvent.filename` (Windows installs live under `C:\Users\<username>\AppData\...`) and follows
the same rules as `stack`. `crashReporter` native dump events are out of scope here; their `binary_images`
remain used for product binary determination.

### `api` / `resource`

`url` and `name` keep only `protocol//host` plus unified routing and drop query and fragment; ID, hash and
email shapes in routing segments become placeholders. `message` (statusText or error summary) follows the text
redaction rules.

The text implementation is `redactTelemetryText` in `@zcode/shared`, kept in the same mode as the CLI
[`error-sanitizer`](../trace/cli-agent-telemetry.md). Adding an automatic collector or a field carrying free
text must extend this section together with that implementation.

## Structured exception text (`[Object]` etc.)

Exception text may contain unreliable JSON objects or markers such as `[Object]`. Automatic collection must
handle these robustly with the same redaction rules and bounded truncation, keeping the text and the whole JSON
object; markers like `[Object]` are no longer stripped for readability. Do not treat `[Object]` as an illegal
character, filter it or truncate midway; assertions must first parse the JSON in a way that may throw and only
on failure safely filter illegal characters.

Out of scope here: exporting auto-collected event data from ARMS to other destinations (app tray upload,
production Web RUM SDK, etc.); introducing such metadata requires updating this document.

## Initialization location and order

1. `desktopEarlyDataBaseDirBootstrap` (`dataBaseDir`)
2. `appCrashCaptureBootstrap` (`crashDumps` + local archive)
3. `appARMSBootstrap`: **starts** `armsRum.init()` at module load and exports `armsInitPromise`
4. Inside `app.whenReady()`, **before creating the main window**, `await armsInitPromise`
5. Renderer: main-process `autoInject` + `browserCollectors` inject and `RumSDK.init` at `dom-ready` (no manual
   init in preload/renderer)

`init()` must be called before `app.ready` (guaranteed by the side-effect import chain) and must be **awaited**
before opening the first window. `browserCollectors` only applies to collectors injected into the renderer;
main-process `collectors` still cover the Electron side (crash, rpc, etc.).

## Local verification

1. Start Desktop (`pnpm dev:desktop` or equivalent).
2. Open the main window and operate (switch pages, trigger requests).
3. Check main-process logs:
   - Success: `[arms] electron initialized env=local version=...`
   - In development before each report: `[arms] beforeReport batch=N perf=1 ... [view:perf, ...]` (`perf` should be >= 1)
   - Failure: `[arms] electron init failed:`
4. Wait about 1-2 minutes, then check **User Experience Monitoring > Application List** in the ARMS console;
   development builds upload with environment **`local`**, so do not filter to `prod` only.

## No data in the console

| Symptom                                                                    | Possible cause                                                                                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No `electron initialized` log                                              | `init` threw (wrong endpoint, remote config fetch failed, etc.)                                                                                        |
| Initialized but no `beforeReport`                                          | Session not sampled (`sessionConfig.sampleRate: 1` required), or the renderer process produced no events                                               |
| `beforeReport` present but `perf=0` (`view:webvitals` without `view:perf`) | `autoInject` ran later than `load`, so perf-collector did not `sendPerf`; the main window's `scheduleArmsBrowserPerfLoadNudge` re-sends `load`         |
| `beforeReport` present but still no console data                           | Console environment filter set to `prod`, region/application mismatch, intranet cannot reach `*.aliyuncs.com`                                          |
| `[RUM] Invalid bundle received from renderer, dropped`                     | The SDK reports `events[]` upstream; the ARMS frame preload closure bypasses the ipc patch; preload must call `patchArmsEventBridgeSend` synchronously |
| Renderer console `[RUM] ArmsEventBridge is not available`                  | First window opened before init finished (fixed by `await armsInitPromise`)                                                                            |

## SourceMap

Production builds use hidden sourcemaps. `@arms/rum-vite-plugin` automatic upload is not integrated; when needed,
upload manually in the ARMS console by application ID `arms-id-placeholder` and the root `package.json`
`version`.

## Sentry removal impact

Desktop Sentry has been removed; Renderer/main crashes and JS errors are covered by ARMS. Host utility and Web
remote-control RUM are not in this chain; CLI Agent unexpected exit and spawn errors are reported only through
desktop main's custom stability events, not by the Electron crash collector.
