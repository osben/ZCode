# 11A Provider Runtime Complete Disposal Functional Fix

> Status: Completed (2026-08-25)
>
> Nature: functional fix found while reviewing [`Todo 11`](./todo-11-provider-runtime-composition-boundary-cleanup.md)
>
> Related design: [`../design/registry/runtime.md`](../design/registry/runtime.md)
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-11a-provider-runtime-disposal-functional-fix.md`

## 0. Positioning

Fixes only the Agent Protocol process not releasing all Provider process resources. It does not depend on Todo 11's
rulings on composition boundary, naming or public API and was implemented independently. It restores the complete
disposal semantics the existing lifecycle object already declares while Todo 11 is shelved; if Todo 11 later reorganizes
the composition root, the new outermost owner carries the same release responsibility.

## 1. Confirmed Problem

The outer result of `startProcessProviderRegistryRuntime()` owns: Credential Store subscription (standalone Prompt/TUI
only), Model Selection Config Repository (Node `fs.watch`), and the Node Provider Registry Runtime (Provider Registry
Service, Provider Config watchers/repositories). Outer `dispose()` releases everything by ownership; inner
`runtime.dispose()` releases only Registry and Provider Config resources.

| Entry          | Disposal call (before)                            | Result                                |
| -------------- | ------------------------------------------------- | ------------------------------------- |
| Prompt CLI     | outer `providerRegistryRuntime.dispose()`         | complete                              |
| TUI            | outer `providerRegistryRuntime.dispose()`         | complete                              |
| Protocol Agent | inner `providerRegistryRuntime.runtime.dispose()` | misses the Model Selection Repository |

The normal Protocol Agent start provides a Model Selection Config file path; after the first `read()` the Repository
creates a persistent `fs.watch` that inner disposal never closes. So after the Protocol transport closed, the Model
Selection `fs.watch` stayed alive, the Node event loop could not drain, and the CLI exit watchdog had to force
`process.exit`. This did not change selection results or corrupt config but turned a normal Protocol Agent exit into a
watchdog-dependent forced exit.

## 2. Rules

1. Protocol Agent exit calls the outermost `dispose()` of the `startProcessProviderRegistryRuntime()` result
   (`providerRegistryRuntime?.dispose()` instead of `providerRegistryRuntime?.runtime.dispose()`), still run through
   `runProtocolCleanupStep` so one failing step neither skips later Telemetry shutdown nor overrides the original error.
2. One call releases the Model Selection Repository, Registry and Config file resources; Prompt CLI, TUI and Host
   lifecycles are unchanged; after exit this task's Model Selection watcher no longer keeps the event loop alive.
3. The existing disposal order is unchanged: stop receiving Standalone Credential changes, close the Model Selection
   Repository watcher, release Registry and Provider Config. Protocol creates no Standalone Credential subscription, so the
   confirmed leak is only the Model Selection watcher; calling the full owner also guards future outer resources.
4. Tests use the outer owner as the release entry (not manual `repository.dispose()` + `runtime.dispose()`), and do not
   rely on the CLI's one-second exit watchdog to judge cleanup.

## 3. Non-Goals

No Todo 11 candidate flattening, renaming or composition-root refactor; no deletion of `NodeProviderConfigRuntime`,
`NodeProviderRegistryRuntime` or the Services Runtime; no ruling on the final public API of Node Config resources; Host
and Agent keep their own in-process Registries; no change to Model Selection read/save/sync/default semantics; the CLI
exit watchdog stays as the last resort for unknown handles and cannot replace normal owner disposal; the limited async
window of a Standalone Credential refresh racing shutdown is not handled unless tests show an independent functional failure.

## 4. Acceptance and Result (done)

- Protocol Agent cleanup now disposes the full owner. The lifecycle test wraps the real Process Runtime and observes outer
  and inner dispose separately, proving Protocol calls only the outer owner.
- A composition test proves that after full dispose the Model Selection Repository and Node Provider Registry Runtime both
  refuse reuse; the file watcher closes after a configured path was `read()`. Manual `repository.dispose() +
runtime.dispose()` combinations in existing tests were unified to owner dispose.
- Review also found the Standalone CLI importer still referencing the Effective->Personal projection deleted by Todo 35;
  it now follows Todo 35 with independent tests so real CLI legacy migration does not silently become an empty config.
- Bootstrap targeted tests (27 cases), Bootstrap typecheck, root lint, target-file format check and `git diff --check` pass.
