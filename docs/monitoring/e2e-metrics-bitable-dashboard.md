# E2E Metrics Bitable Dashboard

## Background

`scripts/ci/push-e2e-metrics-to-bitable.mjs` writes the E2E `summary.json` into the Feishu multi-dimensional table `E2E Test Metrics` table `e2e_runs`. The dashboard trend chart originally used `started_at` as the horizontal coordinate, and multiple submissions on the same day are scattered by random submission time, making the overall trend difficult to read.

## Field Conventions

The dashboard depends on two base computed formula fields, whose values are calculated instantly from historical records and do not require the push script to write them additionally:

- `started_day`: `TEXT([started_at], "YYYY-MM-DD")`
- `started_day_time`: `TEXT([started_at], "MM-DD hh:mm")`

Windows run records additionally write `windows_version`. This field first reads the `Win32_OperatingSystem.Caption` of the running machine, retains the real product information such as Server / Home / Pro / Enterprise / Education; the edition must not be derived solely from the kernel build. When the product description is unavailable, only the original Windows build is recorded without fabricating `Pro` or other editions.

When adding a new trend chart, do not use `started_at` directly as the overview horizontal axis. The overview uses `started_day`, and the platform-specific dashboard uses `started_day_time`.

## Dashboard Hierarchy

Currently three dashboards are maintained within the Base:

- `E2E Test Quality Dashboard`: Overview dashboard. The trend component aggregates by `started_day`; throughput and timing-type metrics take `AVERAGE`, and failure-count metrics take `SUM`.
- `E2E Test Quality Dashboard - macOS`: macOS-specific dashboard, uniformly filtered by `platform = darwin`.
- `E2E Test Quality Dashboard - Windows`: Windows-specific dashboard, uniformly filtered by `platform = win32`.

The overview dashboard does not retain separate macOS/Windows data or platform comparison charts; platform data is only placed in independent platform dashboards.

Each independent platform dashboard includes:

- Overview metric card: run count, average throughput, failure count, Assertion failure, Timeout failure, Crash failure, Infra failure.
- Trend chart: throughput trend, Case duration P50/P95, Suite total duration, failure count trend.

Independent platform dashboards display each submission time point by `started_day_time`.

## Maintenance Notes

- When adding a new platform, prioritize copying the component structure of the existing independent platform dashboard and only replace the `platform` filter value.
- If Base or table is rebuilt, first restore the above formula fields, then create the dashboard components.
- Feishu dashboard block update interface has rate limiting; when batch modifying components, execute in serial and leave a short interval between requests.
- Bitable token and record write requests each have a 30-second timeout; request failure or timeout must return a non-zero exit code, and the caller decides whether to block the current CI.
