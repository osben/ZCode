# Model trajectory v2 view

The side-pane tab `model-trajectory-v2:<taskId>` (specs/model-trajectory-v2.md). It reads one task's trajectory through `IZCodeTaskService.getModelTrajectoryV2` via the existing task service hook, so desktop and mobile remote use the same Host attachment; it never reads files or databases itself.

- The Host owns facts. This module owns presentation only: ledger rows, metrics, strip geometry and context series are pure functions of the response, recomputed on new data.
- Refresh is manual. Previous data stays visible while refreshing; a response that is older than the latest request or arrives after unmount is dropped.
- Selection, time range and zoom live in pane memory and are reconciled against new data. Preferences (charts collapsed, sidecars shown) are per device in localStorage `zcode.modelTrajectoryV2.view.v1`, never in settings.
- `contract.ts` is the only file that imports `@zcode/services`; layers are domain < app < ui (components).
