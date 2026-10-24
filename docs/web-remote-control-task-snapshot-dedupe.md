# Web Remote Control Task Snapshot In-Flight Dedupe

## Background

On first-screen recovery of mobile remote control, several UI hooks call `zcodeTaskService.getTaskSnapshot(...)`
concurrently. With a large task, the host then returns several oversized snapshots in a row and sends large
packets through the relay repeatedly.

## Change

`packages/ui/src/hooks/useZCodeTaskService.ts` adds concurrent dedupe for `getTaskSnapshot`:

- Key dimensions: `workspacePath + workspaceIdentity + taskId + messageLimit + byteBudget + toolLimit + clientMode`
- Behavior: concurrent requests with the same key reuse one Promise and issue only one RPC
- Lifecycle: removed from the in-flight map as soon as the request completes

`clientMode` must be part of the key. Desktop `desktop-continuous` and mobile `web-remote-replayable` have
different snapshot recovery semantics: the mobile side may carry running-state recovery, active prompt
stitching, replayable command state and a byte budget, while the desktop side keeps the full continuous old
semantics. An old call that does not pass `clientMode` is treated as `desktop-continuous`.

## Effect

- Fewer duplicate `getTaskSnapshot` RPCs at the same moment
- Directly fewer duplicate large relay messages for remote control
- The existing interface is unchanged and transparent to callers
