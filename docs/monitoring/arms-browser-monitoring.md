# ARMS Electron Monitoring

Currently only `@arms/rum-electron` is accessed on the Electron desktop end. Web/mobile remote control end is not connected to ARMS Browser SDK yet. ARMS SDK is only accessed at the main process entry, not into `packages/ui`.

Reference: [Alibaba Cloud ARMS Electron Integration Documentation](https://www.alibabacloud.com/help/zh/arms/user-experience-monitoring/integrating-with-an-electron-application)

## Monitoring Scope

ARMS is responsible for Electron runtime user experience monitoring:

- Global JS Error、Promise rejection（main process + SDK automatic injection Renderer）。
- XHR/fetch API success rate、failure rate、duration、status code。
- Renderer longTask / LoAF / rAF main thread stuttering events; main process `beforeReport` only补补 low cardinality attribution summary, not补 original script name or URL。
- Electron main process exceptions、native crashes、application startup related events（`application` collector）。
- RPC calls（`rpc` collector, requires main process tRPC to use `instrumentTRPC`）。

ARMS not responsible: Host/Agent business logs、quality statistics database、`/report` business embeds、Web remote control end RUM。Agent unexpected exit not rely SDK automatic collection, by Host lifecycle bridge主动 sends sanitized `perf_agent_crash` / `perf_agent_spawn_error` custom events.

## Console Error Collection Boundary

Desktop main logger outputs errors by `console.error(prefix, message, context)`, where `prefix` is
`[timestamp] [pid] [source]` common prefix, `source` includes `main`、`renderer` etc. ARMS Electron
SDK's console collector must normalize multi-parameter calls at collection boundary, cannot treat
only the first parameter as `exception.message`:

```text
console.error(prefix, message, context/Error)
                    │
                    ▼
          ARMS console collector
          ├─ Error：保留 name / message / stack
          └─ 非 Error：去掉公共前缀，再安全序列化剩余参数
                    │
                    ▼
         有界、脱敏的 exception.message
```

Normalization rules:

- When parameters contain `Error`时，继续优先上报该对象，保留 original stack。
- Non-`Error` multi-parameter calls remove the first main logger common prefix (`main` / `renderer` etc. source), then concatenate
  strings and contexts by calling sequence.
- Perform desensitization on object keys and common token text; recursive references must not cause collector to throw.
-最终 message max 2000 characters; only have common prefix, no business text时不产生 exception event.
- `clean-exit` / `killed` etc. controlled exit belongs to lifecycle information, use `info`；recoverable exceptions use
  `warn`；only confirmed crash、OOM、startup failure etc. use `error`。

## Dependency Patch Installation Constraints

Repository uses `node-linker=hoisted`, current ZCode patch fixed based on `@arms/rum-electron@0.0.3`。 Modifying patch must
from that version's original `dist/index.mjs`一次性重新生成完整 unified diff，禁止直接向 existing patch
追加 hunk；否则 subsequent hunk 的 target line numbers and target blob hash 会与 complete result inconsistent, pnpm 10 second
`pnpm install` 会再应用 patch 到已 patch 文件并报 `ERR_PNPM_PATCH_FAILED`。 Patch modification后 must verify
patch head's target blob 与 install product一致，并 verification same workspace consecutive execute two `pnpm install`
both successful。

## Configuration (hardcoded)

| Item                         | Location / Value                                                                                                         |
|------------------------------|--------------------------------------------------------------------------------------------------------------------------|
| Endpoint                     | `ZCODE_ARMS_RUM_ENDPOINT`（`packages/shared/src/env.ts`）                                                              |
| Upload environment            | `mapZCodeEnvToArmsRumEnv(runtimeEnv)`：local development runtime always `local`；non-local runtime only `ZCODE_ENV=production` is `prod` |
| `sessionConfig.sampleRate`   | `1`（100% session sampling）                                                                                             |
| `autoInject`                 | `true`（SDK injects Browser SDK at `dom-ready`；勿 preload/renderer manual init）                                       |
| `browserCollectors`          | `perf/webvitals/exception/whiteScreen/api/staticResource/click/longTask: true`（see `ARMS_BROWSER_COLLECTORS`）       |
| `spaMode`                    | `false`（Electron single-page whole page load, not History SPA）                                                         |
| `parseViewName`              | `file://` take html filename；http dev-server take pathname                                                              |
| `tracing`                    | `arms_env=prod`时 `enable: true`、`sample: 0.1`（0.1%）；`arms_env=local`时 `sample: 1`                          |

No `ZCODE_ARMS_*` environment variables.

## longTask Attribution Summary

Browser SDK's `longTask` collector will put LoAF / rAF attribution into `snapshots`。To facilitate SLS query and avoid high cardinality and path leakage， main process `appARMSBootstrap.beforeReport` only puts top attribution summary into same longTask's `properties`:

| Field                    | Meaning                                                        |
|------------------------|-----------------------------------------------------------------|
| `loaf_script_count`     | `snapshots`中 attribution条数，最多 5。                         |
| `loaf_top_duration_ms`  | top attribution duration ms。                                   |
| `loaf_top_invoker_type` | `user-callback` / `event-listener` / `script` / `unknown`。   |
| `loaf_top_share_pct`    | top attribution占 longTask `duration`百分比整数。             |

This enhancement does not add events、does not change sampling rate；`snapshots`缺失或解析失败时跳过。禁止把 original script name、URL、file path、selector、stack或源码片段写入 these properties。

## Automatic Collection Events Desensitization Boundary

SDK collector's collected fields by ARMS决定，其原始 content可能 contain user interface text、native path和full
URL。`appARMSBootstrap.beforeReport`是 these events leave 本机 before longest must执行脱敏 on整批 events at
longTask attribution summary之后、返回payload之前。 Desensitization only rewrites reporting copy，不改变 local logs、error
rendering、crash archive和 `perf_network_window`的 aggregation口径（network aggregation在脱敏 before完成 ingest，retain
`normalizeHttpInterface` own dimension rules）。

### `click`

Browser SDK的 `name` 形如 `click on <type-><tag>: <innerText 前 20 字符>...`，
`snapshots`为 `{id,name,className,href,src}`的 JSON。ZCode的可点击文本包括会话标题、
workspace directory name、filename、message body and account email，因此:

- `name` only retains `click on <type-><tag>`，截掉 `: `之后 element text。
- Delete `snapshots`（`href` / `src`可能是 local file path，`id` / `className`无 diagnostic value）。
- Retain `target_name`（XPath only express structure position，不含 text） and duration、view等 non-content fields。

### `exception`

`jsError`（`uncaughtException` / `unhandledRejection`）、`consoleError`、`whiteScreen`与
renderer侧 exception 的 `message` / `stack` / `file` / `snapshots`按 unified text desensitization rules processing：URL only leave
`protocol//host`与 unified routing、absolute path unified as `{path}`、email unified as `{email}`、credentials与
Authorization unified as `{redacted}` / `{secret}`，并做有界截断。 Dependency patch 中的 console desensitization only covers
credentials keywords，path与email由本节收口补齐。`file` is SDK from `ErrorEvent.filename` collected script URL，
Windows installation version located at `C:\Users\<username>\AppData\...`，must与 `stack` 同 rules processing；
`crashReporter` native dump event not in this section range，其 `binary_images`仍用于 product binary determination。

### `api` / `resource`

`url`与 `name` only retain `protocol//host`加 unified routing，丢弃 query与 fragment；routing segments中的
ID、hash、email形态 unified as placeholder。`message`（statusText or error summary）按 text desensitization rules processing。

上述 rules的 text implementation is `@zcode/shared`的 `redactTelemetryText`，与 CLI
[`error-sanitizer`](../trace/cli-agent-telemetry.md)保持 same套 mode；新增 automatic collector or 新增
carry free text fields时 must同步扩展 this section with该 implementation。

## Initialization Location and Order

1. `desktopEarlyDataBaseDirBootstrap`（`dataBaseDir`）
2. `appCrashCaptureBootstrap`（`crashDumps` + local archive）
3. `appARMSBootstrap`：module loading时**启动** `armsRum.init()`，export `armsInitPromise`
4. In `app.whenReady()`内、**创建 main window之前** `await armsInitPromise`
5. Renderer：由 main process `autoInject` + `browserCollectors` at `dom-ready`注入并 `RumSDK.init`（无 preload/renderer manual init）

`init()` must in `app.ready`之前 be called（side-effect import chain保证）；同时 must **await**完成后再开首窗。`browserCollectors` only作用于 inject到 renderer的 collector；main process `collectors` still管 Electron side（crash、rpc等）。

## Local Verification

1. Develop Desktop启动（`pnpm dev:desktop` or equivalent command）。
2. Open main window and operate（switch pages、trigger requests）。
3. 查看 main process logs：
   - Success：`[arms] electron initialized env=local version=...`
   - Development每上报前：`[arms] beforeReport batch=N perf=1 ... [view:perf, ...]`（`perf` should ≥1）
   - Failure：`[arms] electron init failed:`
4. Wait about 1-2 minutes，在 ARMS control console **User Experience Monitoring > Application List**查看；development build upload environment为 **`local`**，filter勿只选 `prod`。

## Still No Data When Control Console

| Phenomenon                                                                | Possible cause                                                                                         |
|--------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------|
| No `electron initialized` log                                      | `init`抛错（endpoint error、network pull remote config failure等）                                            |
| Have initialized but no `beforeReport`                                  | Session not sampled（须 `sessionConfig.sampleRate: 1`）、or renderer process not produce events                                          |
| Have `beforeReport` but `perf=0`（have `view:webvitals`无 `view:perf`） | `autoInject` late than `load`，perf-collector未 `sendPerf`；main window `scheduleArmsBrowserPerfLoadNudge`补发 `load` |
| Have `beforeReport` control console still no data                            | Control console environment filter to `prod`、region与 application inconsistent、intranet无法访问 `*.aliyuncs.com`         |
| `[RUM] Invalid bundle received from renderer, dropped`              | SDK上report events[]；ARMS frame preload闭包绕过 ipc patch；须 preload同步 `patchArmsEventBridgeSend`           |
| Renderer control console `[RUM] ArmsEventBridge is not available`            | 首窗 early than init完成（should already through `await armsInitPromise`修复）                                             |

## SourceMap

Production build uses hidden sourcemap。Not access `@arms/rum-vite-plugin` automatic upload；needs时 in ARMS control console按 application ID `arms-id-placeholder` with根 `package.json`的 `version`手动 upload。

## Sentry Removal Impact

Desktop Sentry has been removed，Renderer/main crash and JS error由 ARMS承接。Host utility与 Web remote control RUM not in this chain; CLI Agent only通过 desktop main的 custom stability events reporting unexpected exit and spawn error，不由 Electron crash collector automatic collection。

## 后续更新

本文件不记录自动收集事件数据从 ARMS 导出到的其他 destination，比如应用托盘上传、生产 Web 端 RUM SDK 等。持续演进过程中若要新建 metadata，必须更新本章节。

## `[Object]`等结构化异常解析

Document会不可靠的 JSON 对象、带有 `[Object]` 等标记的异常文本；需要自动收集器能 robust 处理这些标记和文本，采用 same脱敏规则和有界截断，保留文本和整个 JSON 对象，不再为了程序可读去掉 `[Object]` 等标记。Avoid 将 `[Object]` 视为非法字符、直接过滤或中途截断；断言必须先以可能抛错的方式 parse JSON，失败了才可安全过滤掉非法字符。