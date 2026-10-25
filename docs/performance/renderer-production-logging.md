# Renderer Production Logging Policy

## Background

The renderer runs inside the desktop window and the Web remote page, and log calls compete with React
rendering, message stream handling and remote recovery for main-thread time. UI logs used to be written
to console and forwarded on desktop through `window.zcode.log` to the main process for disk logging;
when sessions streams, tool calls, task snapshots and remote sync grow, this synchronous formatting, IPC
forwarding and file writing amplifies production performance cost.

## Goals

- Local renderer logs are off by default in production builds.
- UI logs in production builds are no longer forwarded to the main process through `window.zcode.log`
  for disk logging.
- Development builds keep the renderer console and the desktop log bridge for local debugging.
- Formal monitoring chains are outside this policy's scope: ARMS, telemetry, crash capture, user-
  initiated log export, service-layer logs and host/main process logs.

## Environment boundary

The log switch follows the Vite build state `import.meta.env.PROD`, not `ZCODE_ENV`:
`ZCODE_ENV=production` only means connecting to the production product environment, and
`dev:desktop:prod` is still a local development runtime that needs renderer logs for debugging. Only a
real production build makes local renderer logs no-op. Tests or diagnostics may force-disable renderer
logs with `globalThis.__ZCODE_RENDERER_DISABLE_LOGGING__ === true`; that switch can only disable logging
additionally and never re-enables it in a production build.

## Implementation constraints

- `packages/ui/src/logger.ts` is the only UI log entry; in production builds `debug` / `info` / `warn` /
  `error` / `trace` return immediately, writing no console and forwarding to no desktop bridge.
- Renderer-facing connection logs in `packages/client` must follow the same production-build boundary
  and must not bypass the UI logger.
- The only exception is `logger.logMemoryDiagnostics`: it is the formal monitoring exit of the
  [process memory local diagnostic log](../monitoring/memory-diagnostics-log.md), at most one line per 60
  seconds and written only on change; production builds still persist it via the desktop bridge, and it
  is a no-op on Web without a bridge. Other modules must not borrow it for business logs.
- Console debug output in the desktop and Web renderer entries may run only in non-production builds.
- Web remote relay trace stays development-only; high-frequency message logs must not enter the
  production renderer.

## Verification

- Unit tests cover output in development builds and no output in production builds.
- Run `pnpm typecheck`.
- Run `pnpm lint`.
