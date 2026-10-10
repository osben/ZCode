# @zcode/dynamic-workflow-runtime

A sandbox harness (dynamic workflow execution engine). It runs a workflow script in a controlled child process and uses NDJSON to bridge the child's `__host.*` calls to the pure engine core in `@zcode/dynamic-workflow`.

## Dependency Boundary

Depends **only** on `@zcode/dynamic-workflow` (workspace) and Node built-ins. It must **never** import `@zcode/core` / `@zcode/contracts` / `@zcode/bootstrap` / `@zcode/adapters`—this package proves that the full sandbox-to-engine pipeline can run without the app.

## Usage

```ts
const settlement = await runWorkflowScript({
  scriptText,                 // or lowered: <async function body>
  caps: { maxConcurrency: 16 },
  askSpecs,                   // a site ID listed in synthetic schemas is typed
  validate,                   // validate from @zcode/dynamic-workflow, adapted to ValidateFn
  makeDriver: (sink) => driver, // driver includes journal + emit; sink is the engine's upward reporting channel
  signal,                     // optional: AbortSignal
  timeoutMs,                  // optional: wall-clock timeout
});
// settlement: { status: "completed", artifact } | { status: "failed", error } | { status: "cancelled" }
```

## Architecture

```
┌─ parent (harness) ──────────────┐  NDJSON  ┌─ child (vm.createContext) ──────┐
│ runWorkflowScript               │  stdio   │ ES intrinsics + __host only       │
│  - lower(scriptText)            │◀────────▶│ createActor returns a local handle synchronously │
│  - WorkflowEngine(driver,...)   │          │ ask/worldRead → request to parent process       │
│  - bridge __host.* ↔ engine     │          │ args frozen global (cross boundary once on spawn) │
│  - spawn/kill/timeout/abort     │          │ Date.now/Math.random prohibited at runtime      │
└─────────────────────────────────┘          └──────────────────────────────────┘
```

## NDJSON Wire Protocol

See `src/protocol.ts` (the single source of truth). Child → parent: `create-actor` (fire and forget) / `request` (`ask`, `world-read`) / `event` (`log`) / `complete`; parent → child: `response`.

## Build Order

Tests and typecheck resolve dependencies through the **built `dist`** of `@zcode/dynamic-workflow`, so `pretest` / `pretypecheck` first run `pnpm --filter @zcode/dynamic-workflow build`. On a fresh checkout, run `pnpm test` directly; it will not encounter stale dist output.

## Failure Ownership and Tradeoffs

- The engine owns run settlement. All terminal failures (script exception / child-process crash / timeout / protocol corruption) call `engine.fail(error)`—settling as `failed`, cancelling in-flight asks on the driver side, and recording `dwf_run.status = "failed"` plus `failure_json` in the journal so the journal and caller see the same result. The abort signal is the only true cancellation; it calls `engine.cancel()` (settles as `cancelled` and can be resumed). The harness's first-wins finalize handles child-process cleanup only (clear timer, close stdin, kill child); it does not create its own settlement.
