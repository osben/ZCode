# Bugfix 05: Worker Registry Self-Recovery on Personal Config Refresh

> Status: Completed
>
> Date: 2026-08-27
>
> Source: macOS Provider Settings real-machine connectivity test long-term `provider-not-found`
>
> Lock boundary revision (2026-09-15): pure polling and standard-format normal reads no longer take exclusive locks;
> import, normalized rewrite and update still use the original write lock. Current lock scope and concurrency
> constraints: [Pure Read Lock Removal TODO](../../../analysis/2026-09-15-provider-config-read-lock-todo.md).
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/bugfix-05-personal-config-worker-refresh.md`

## 1. Problem and Root Cause

After saving a new Personal Provider, the Host Settings View showed it, but the model connectivity test could
long-term return `Provider not found in the Provider Registry: <providerId>`; clicking again did not help; a Worker
or app restart, or a later file change, recovered it.

The Host and the Core Worker each hold an in-process Provider Registry. The Host refreshes its own after saving; the
Worker refreshed only when it observed the external Personal Config change, and the only cross-process observation
was `fs.watch` on the directory. Production save is atomic (write same-directory temp file, `rename` to
`config.json`), and the repository scheduled a re-read only when `fileName` was `null` or exactly the target name.
`fs.watch` event forms differ across macOS / Windows / Linux, so a missed event left the Worker serving the old
Registry forever. Amplifiers: a watcher `error` only published an error (no cleanup or rebuild); a read failure
after a trigger had no retry; the connectivity test synchronized only Account Config, not Personal Config. The old
test used direct `writeFile(config.json)` and never covered two independent Runtimes with the formal atomic write or
total event loss.

## 2. Decision

Personal Config no longer uses `fs.watch`. The Repository keeps one cross-process observation mechanism: a
low-frequency asynchronous re-read of the target file that compares the content revision.

```text
Repository start/read -> record observed content revision
  -> async polling (default ~1 s) -> read Personal Config (within the file lock at that time)
  -> same revision: no event
  -> revision changed: update observed revision + publish personal:poll-changed + normal Registry refresh
```

No long-term `fs.watch + poll` combination; no Host/Worker revision barrier, full Config transmission or Registry
Snapshot sync. Polling reads only the local Personal Config of the current Environment, never the server, and is not
the remote Built-in refresh.

## 3. Repository Constraints

1. A single async polling loop starts after the first `read()` or Runtime `start()`; default interval about 1
   second, injectable shorter for tests.
2. The next round is scheduled only after the current one completes (no overlapping reads); async file IO and the
   existing file lock.
3. Compare the formal content revision, never file name, mtime, size or inode. Same revision: no Source change and
   no Registry replace.
4. Temporary read, lock or parse failure: report an observable error (once on entering the error state) and retry
   next round.
5. The Timer calls `unref()`. After `dispose()` the next round is cancelled and no event is published even if an
   in-flight read completes.
6. `FSWatcher`, directory event filtering, watcher error handler and rebuild state are deleted. A `watch?: boolean`
   option that only meant "disable external observation" becomes an explicit polling option, with no misleadingly
   named compatibility layer.
7. In-process `update()` still publishes immediately: after the atomic write it sets `observedRevision` to the new
   revision and emits `updated`; the next poll reads the same revision and does not emit again. Host save does not
   wait a second; other processes catch up within about one polling interval.

## 4. Connectivity Test Refreshes Proactively

The test diagnoses "the config already saved" and must not wait for the next poll. On a connectivity request the
Agent first calls the Worker `ProviderRegistryService.refresh("provider-connectivity")` (reads Personal Config,
resolves with current Account Config, waits for Registry publish completion), then looks up providerId/modelId
exactly and temporarily creates the formal Model through the formal execution chain.

The Host does not issue the model HTTP request (it does not own the Adapter/ModelFactory chain; a copied
connectivity protocol would let tests pass while real chat fails), and no bypass Model is built from the Renderer
draft, the Host Registry Snapshot or a hand-assembled Provider Config. Refresh failure returns the real
Config/Registry error; a saved-but-incomplete Provider still fails as the Registry non-executable error.

## 5. Operating Semantics

```text
In-process save        -> refresh current Registry immediately
Other process saves    -> catch up within about one polling interval
Connectivity test      -> catch up at request start
New Worker startup     -> first start/read reads the latest file
Long-lived Worker      -> polling gives eventual consistency
```

Refresh affects only later Registry lookups and Model creation; already-created Active Models stay frozen (Provider
Config, Model Config, Endpoint, access materials). Desktop Local Host, Web Remote and Remote Workspace each read
only their own Environment's Personal Config; never poll or copy local Personal Config to a remote Environment.

## 6. Tests and Completion

Repository: two independent repositories on one file with formal atomic write publish the revision within one
interval; changes are detected with no file events; same content, repeated atomic writes and in-process `update()`
do not notify twice; no next round before the current read completes; lock, temporary missing or read failure
recover next round; `dispose()` cleans the Timer and suppresses in-flight emit; Timer does not block process exit;
no `FSWatcher` / `fs.watch` in the Personal Repository.

Registry and connectivity: Worker Registry publishes the new Provider after revision change; connectivity test
right after save finds the Provider without waiting; active Session and temporary connectivity App share the
refreshed same-process Registry; config read failure, incomplete Provider and missing Model keep accurate errors; no
second Registry, Provider Snapshot or test-specific Model DTO; Active Model stays frozen.

Regression: Account Config keeps syncing through the existing Protocol (not merged into Personal polling); Built-in
Active/LKG and remote refresh unchanged; Model Selection, Provider Settings and model requests see one Registry
fact; no OS depends on its file-event implementation.

Outcome: `@zcode/provider-node` 44 tests, Services Provider Runtime 11 tests, Bootstrap protocol 108 tests and
related typecheck passed. Open: macOS real-machine "connectivity test immediately after saving" re-verification is
left for the final manual verification stage.
