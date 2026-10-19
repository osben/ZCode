# Storage preparation worker exits as soon as it is done

Status: implemented (2026-10-18). Found by the desktop performance pass and verified with an interleaved A/B benchmark against a per-metric noise floor; the numbers are in the pull request description.

## Problem

On every desktop launch, the Host prepares the session database before it starts local services (`packages/desktop/src/host/hostDatabaseStartup.ts`). `prepareSessionStorage` (`packages/desktop/src/host/storagePreparationProcesses.ts`) runs the agent CLI bundle in a `worker_threads` Worker with `--prepare-storage` and waits for the worker's `exit` event before it continues.

The worker finishes its work (`startup/storagePrepared`) about 1 s before it exits:

- `prepareProtocolStartupStorage` (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/storage-startup.ts`) reads the Host's acknowledgement with `readline` and then calls `lines.close()`. Closing a readline interface pauses its input stream.
- In a Worker, `process.stdin` is a worker stdio stream. Once it has started reading, it keeps the worker's internal stdio `MessagePort` referenced until the stream emits `end`. A paused stream never reads the EOF that the Host sends with `input.end()`, so `end` never fires and the port stays referenced.
- The event loop never drains. The CLI's exit watchdog (`scheduleCliExitWatchdog`, 1000 ms) finally calls `process.exit(0)`.

As a child process the same code exits about 30 ms after `storagePrepared`. The delay is specific to the Worker, which is how the Host runs it.

Measured (replay of the Host's handshake in a Worker against a scratch home, Node 26): `storagePrepared` at about 500 ms, worker exit at about 1500 ms. With the input stream resumed after `lines.close()`, exit comes at about 440 ms. In the desktop E2E build, `[database-startup] terminal` reports `durationMs` about 1500 ms, and services start only after it. The time-to-input mark (`launch.inputReadyMs`) is about 3.0 s.

## Product rule

After `prepareProtocolStartupStorage` has finished with its input (success or failure), it lets the input stream flow to its end, so the Worker's stdio port is released when the Host ends the input. The Host protocol does not change: the Host still sends one `startup/storagePathReady` line and ends its input after `startup/storagePrepared`.

## State owners and interfaces

- Owner: `prepareProtocolStartupStorage` owns the input stream it is given for the duration of the call. Nothing else reads it in `--prepare-storage` mode.
- No protocol, schema, database or setting change. The Host side (`storagePreparationProcesses.ts`) is unchanged.
- Lines that arrive after the acknowledgement are discarded. The protocol defines none.
- The exit watchdog stays as the backstop for other unknown handles.

## Acceptance scenarios

1. Unit (`apps/zcode-cli/packages/bootstrap/tests/storage-startup-input-drain.test.ts`): after `prepareProtocolStartupStorage` resolves, ending the input stream emits `end`. Before the fix it does not, because readline paused the stream.
2. Unit: the same holds when preparation fails after the acknowledgement.
3. Benchmark A/B (desktop performance benchmark, E2E production build): `S1.launch.inputReadyMs` improves beyond its noise floor, and no gating metric regresses.
