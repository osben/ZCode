# Storage preparation worker exits as soon as it is done

Status: implemented (2026-10-18).

## Problem

On every desktop launch, the Host prepares the session database before it starts local services
(`packages/desktop/src/host/hostDatabaseStartup.ts`). `prepareSessionStorage`
(`packages/desktop/src/host/storagePreparationProcesses.ts`) runs the agent CLI bundle in a
`worker_threads` Worker with `--prepare-storage` and waits for the worker's `exit` event before it
continues.

Without the fix below, the worker finishes its work (`startup/storagePrepared`) about 1 s before it
exits:

- `prepareProtocolStartupStorage` (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/storage-startup.ts`)
  reads the Host's acknowledgement with `readline` and then calls `lines.close()`. Closing a readline
  interface pauses its input stream.
- In a Worker, `process.stdin` is a worker stdio stream. Once it has started reading, it keeps the
  worker's internal stdio `MessagePort` referenced until the stream emits `end`. A paused stream
  never reads the EOF that the Host sends with `input.end()`, so `end` never fires and the port stays
  referenced.
- The event loop never drains. The CLI's exit watchdog (`scheduleCliExitWatchdog`, 1000 ms) finally
  calls `process.exit(0)`. As a child process the same code exits about 30 ms after
  `storagePrepared`; the delay is specific to the Worker.

## Product rule

After `prepareProtocolStartupStorage` has finished with its input (success or failure), it lets the
input stream flow to its end, so the Worker's stdio port is released when the Host ends the input.
The Host protocol does not change: the Host still sends one `startup/storagePathReady` line and ends
its input after `startup/storagePrepared`.

## State owners and interfaces

- Owner: `prepareProtocolStartupStorage` owns the input stream it is given for the duration of the
  call. Nothing else reads it in `--prepare-storage` mode.
- No protocol, schema, database or setting change. The Host side (`storagePreparationProcesses.ts`)
  is unchanged.
- Lines that arrive after the acknowledgement are discarded. The protocol defines none.
- The exit watchdog stays as the backstop for other unknown handles.

## Acceptance scenarios

1. Unit (`apps/zcode-cli/packages/bootstrap/tests/storage-startup-input-drain.test.ts`): after
   `prepareProtocolStartupStorage` resolves, ending the input stream emits `end`.
2. Unit: the same holds when preparation fails after the acknowledgement.
3. Benchmark A/B (desktop performance benchmark, E2E production build): `S1.launch.inputReadyMs`
   improves beyond its noise floor, and no gating metric regresses.
