# ZCode All-Process Resource Monitoring

## Confirmed Product Scope

Confirmed through discussion on 2026-09-15: create a separate Alibaba Cloud CMS dashboard, primarily to answer questions about version regressions and resource health, while also supporting single-device investigation and telemetry verification. This phase does not create alerts, subscriptions, or sharing permissions.

- Workspace: `arms-id-placeholder`.
- Data source: Beijing `arms-project-placeholder` / `logstore-rum`.
- App constraint: `service_id = arms-id-placeholder`.
- Consume only `perf_process_window`, `perf_system_window`, and `perf_tool_exec_resource`. The old dashboard remains separate; do not combine old resource events.
- Default to `prod` and the most recent 24 hours. Provide environment, version, and operating-system filters; use hardware filters to control device differences in version comparisons.
- Use two-column charts and seven collapsible sections; emphasize overview and version comparison on the home view.

## Sections

| Section | Contents |
| --- | --- |
| Resource overview | Number of reporting device identifiers, event freshness, device distribution and trends for app CPU/RSS, and whole-machine pressure |
| Version and process role | CPU, RSS, per-process peak, background CPU, JS heap, process counts, and uptime buckets by version/role |
| MCP resource rankings | Rankings of local MCP memory and background CPU by `mcp_id` |
| Slow Bash | Duration, resources, exit type, and sampling for local commands running for at least 15 seconds |
| Remote resources | Role metrics and slow Bash for remote CLI/MCP, separate from local app totals |
| Single-device investigation | Select a device by `device_mid` and show a timeline of local app, roles, and whole-machine context |
| Collection quality | Coverage of three event types and roles, sample counts, heap coverage, and telemetry overhead |

## Metrics Contract

1. Compare versions with new events under the same time range and filters. This phase does not pair devices before and after an upgrade, automatically select a stable version, or calculate increases/decreases between old and new events.
2. For steady-state CPU/RSS metrics, first aggregate the mean window value by device and version, then calculate P50/P95 across devices. Apply the same rule within each time bucket in trend charts. Do not label percentiles of window p95 values as p95 of raw CPU samples.
3. For peaks, first take the maximum per device within the range, then calculate the population distribution. State separate definitions for total role RSS, maximum per-process RSS, and heap. For multiple instances, heap is the maximum single-process reading, not total heap for the role.
4. Show the number of device identifiers in each group. When fewer than 100 are present, label the sample as insufficient; `local` is always for verification only. Values may be inspected but must not receive a regression-health rating or use red/green to indicate whether a version is better or worse.
5. When there are no events, show no data. A known event count may be 0; metrics with no samples, such as CPU, RSS, and ratios, must be null/empty—not zero-filled and not interpolated across gaps.
6. Whole-machine events describe the desktop machine and its local app processes only. For remote data, `device_mid` is the reporting desktop identifier, not a remote physical-machine ID. No remote environment ID is reported, so the dashboard cannot distinguish multiple same-spec remote machines connected to one desktop; do not sum these samples into a remote total.
7. Windows slow Bash has no process-tree resource data; commands with `sample_count=0` do not participate in process-tree consumption metrics. Slow Bash includes only commands lasting at least 15 seconds, so the slow-command rate across all commands cannot be calculated. CPU time/duration is measured in observed CPU-core equivalents and may exceed 1; it does not directly prove waiting for network or input.
8. Bash events have no `arch`, CPU-core-count, or total-memory fields. Hardware filters apply only to process/system sections that have those fields. Do not infer remote total memory for Bash or calculate the percentage of remaining whole-machine memory.
9. Device populations may differ between uptime buckets, so trends are investigative clues and do not diagnose leaks by themselves. Preserve null values for roles/windows without heap data.
10. A low `sample_count` may result from a normal exit with a partial final window, and a missing role may mean it never started; neither alone indicates a collection failure. Telemetry duration is cumulative wall-clock milliseconds spent aggregating main-process samples within the window, not the CPU cost of all telemetry.

## Configuration and Acceptance

The native [JSON](./process-resource-dashboard.json) and [SQL query list](./process-resource-queries.json) can be imported from this directory.

### Delivered (2026-09-15)

- [Live dashboard](https://cmsnext.console.aliyun.com/next/region/cn-beijing/workspace/arms-id-placeholder/app/dashboard/detail/dashboard-1789470797128-483124): `dashboard-1789470797128-483124`.
- 32 data charts/cards, seven collapsible sections, and eight global filters; the query list contains 32 panel queries and one version-list query.
- Fix the default time to the most recent 24 hours using `attribute.time`; use the single-select `env` variable with SQL defaulting to prod, preventing development and production data from being mixed. Keep the native multi-select filter for versions.
- Use the native `classify` transformation for trends to split `time / series / value` into separate lines. Do not only `GROUP BY series` in SQL and rely on the default line chart, or different roles will be connected as one line.
- Keep `xPos=0` on all global filters and order them with `fixedTopOrder` so native layout sorting does not move them into the first collapsed row. Provide a removable tag above the device input; after the tag is cleared, the single-device section returns to its unselected empty state.
- Variables are substituted as-is; strings must be explicitly quoted in SQL. Use the `all` branch for every dimension by default. Do not assume that a prefixed variable is automatically surrounded by SQL quotes.
- Use `HAVING` to exclude no-valid-value results in empty-sample CPU/RSS cards, avoiding a displayed `null%`. Event counts still show the actual zero. The whole-machine CPU trend has a 90% reference line; the memory-watermark table has 40% app-usage and 5% whole-machine-free reference thresholds, with no automatic alerts.
- In the current SLS context, `from_unixtime` already outputs Beijing time; do not manually add 28800 seconds.

### Verification Results

- All 33 baseline queries ran successfully against real SLS. Coverage included local, prod, platform/hardware, foreground/background, and selected/unselected devices. After fixing variable references, key defaults and filter paths were rerun in SQL and verified in a real browser.
- Reopening the browser with default prod / 1 day showed 0 events and devices, with “No data” for CPU/RSS and trends. Queries worked after switching to local / macOS.
- Local observations: 231 process events, 24 system events, two slow Bash events; version 3.12.1. The system comparison table showed 13 device identifiers and “local: verification only.” All new events covered 23 identifiers; this does not mean there were 23 physical machines.
- The page was checked for version comparisons, separate role lines, one normally completed and one terminated slow Bash command, collection coverage, and Beijing time. Single-device input produced a role timeline; clearing its top tag cleared the input. All eight global filters remained when every section was collapsed.
- MCP/remote had no real new samples; SQL successfully returned empty sets. Their real-data distribution, Windows resource-field behavior, and two-version comparison are not yet verified. There are no new production events, so no production-resource conclusions are made.
- `pnpm typecheck` and `pnpm lint` passed; lint reported 0 errors and 43 existing warnings. This change added only dashboard JSON, the query list, and documentation; it did not change app or Agent implementation.

### Follow-up Updates and Rollback

The line-by-line SQL review from 2026-09-15 is in [Dashboard SQL Review](./process-resource-dashboard-review.md). It records confirmed metric-definition issues and suggested presentation improvements; the delivered configuration has not been changed.

Update the existing live dashboard under “Edit → Settings → Dashboard JSON,” keeping the same ID. Preserve the current version before updating; do not create another dashboard with the same name. Restore earlier configurations from the native platform's “Versions” page. After modifying SQL, first run read-only SLS queries, then check the environment, empty states, actual variable substitution, and legends, and finally sync the local files in this directory. After the first prod events and a second version arrive, verify real population metrics, MCP, remote data, and cross-version comparison. Discuss alerts separately.

Native format reference: [Alibaba Cloud dashboard JSON import/export guide](https://help.aliyun.com/zh/sls/import-and-export-sls-dashboards). Metric definitions come from the [all-process resource spec](../process-resource-telemetry.md).
