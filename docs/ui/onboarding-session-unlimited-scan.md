# Onboarding Session Unlimited Scan

## Background

The data-migration wizard under Settings "Onboarding" scans native Claude Code sessions on this machine.
The session step used to offer only `30`, `50`, `100` as return counts; the underlying scan service
already returns all candidates when `limit` is not passed.

## Behavior

- The return-count dropdown of the onboarding session step shows `30`, `50`, `100` and `不限制`
  (Unlimited).
- Selecting `不限制` makes the UI pass no `limit` to `scanImportableClaudeSessions`.
- The service keeps scanning, filtering and sorting by `updatedAt` descending as before; results are
  truncated only when a positive `limit` is passed.

## Boundaries

- Only the session scan option of the onboarding data-migration wizard changes.
- The standalone settings migration page's numeric input keeps its current maximum of 500.
- Import logic, workspace filter, time-range filter and the desktop/web support boundary are unchanged.
