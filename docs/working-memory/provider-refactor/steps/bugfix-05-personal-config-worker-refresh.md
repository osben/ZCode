# Bugfix 05: Self-Recovery of the Worker Registry on Personal Config Refresh

> Status: Completed
>
> Date: 2026-08-27
>
> Source: macOS Provider Settings real-machine connectivity test long-term report `provider-not-found`

> 2026-09-15 Lock boundary revision: pure polling and standard-format normal reads no longer use exclusive locks; import, normalized rewrite, and update still use the original write lock.
> The following records the historical solution; the current lock scope and concurrency constraints are documented at [Pure Read Lock Removal TODO](../../../analysis/2026-09-15-provider-config-read-lock-todo.md).

## 1. Problem

After the user saves a new Personal Provider in the Provider Settings, the Host Settings View already displays that Provider, but the model connectivity test can long-term return:

```text
Provider not found in the Provider Registry: <providerId>
```

Repeatedly clicking the connectivity test does not recover; the Worker restart, application restart, or a subsequent file change may recover.

This is not normal asynchronous refresh delay. The Host and the Core Worker each hold an in-process Provider Registry: the Host actively refreshes its own Registry after saving, but the Worker only refreshes when the Personal Config external change is observed. The only cross-process observation method currently is `fs.watch`; once an event is missed, the Worker has no polling, active re-read, or other self-recovery entry, and will indefinitely serve the old Registry.

## 2. Root Cause

The production save uses atomic write: first writes to the same-directory temporary file, then `rename`s to `config.json`. The current Personal Repository monitors the directory and only schedules a re-read when the `fileName` is `null` or exactly matches the target file name.

```text
Host
├─ write .config.json.<pid>.<time>.tmp
└─ rename tmp -> config.json
          |
          v
The fs.watch event form of macOS / Windows / Linux is inconsistent
          |
          +-- Precisely reports config.json --> The Worker refreshes
          `-- Temporary name, missed event, or watcher error --> The current implementation cannot self-recover
```

There are three amplifying conditions simultaneously:

- The watcher `error` only publishes an error event, without cleaning or rebuilding the failed instance;
- The read failure after the watcher trigger only publishes an error, without subsequent retries;
- The connectivity test only proactively synchronizes the Account Config and does not re-read the Personal Config; consecutive clicks still query the same old Worker Registry.

The existing test simulates the external modification with direct `writeFile(config.json)` and does not cover two independent Runtimes cooperating with the formal atomic write, nor does it cover the recovery after the file event is completely lost.

## 3. Final Decision

The Personal Config no longer uses `fs.watch`. The Repository retains only one cross-process change observation mechanism: asynchronously re-read the target file at a low frequency and compare the content revision.

```text
Repository start/read
        |
        v
Record the observed content revision
        |
        v
Asynchronous polling (default about 1 second)
        |
        v
Read the Personal Config within the file lock
        |
        +-- The revision is the same --> Do not publish an event
        `-- The revision changes --> Update the observed revision
                                      + Publish the personal:poll-changed
                                      + The Registry normal refresh
```

Do not simultaneously retain both `fs.watch + poll` long-term mechanisms; do not add the Host/Worker revision barrier, the complete Config transmission, or the Registry Snapshot sync. The polling only reads the local Personal Config file for the current Environment and does not access the server, nor does it belong to the remote Built-in refresh.

## 4. Repository Implementation Constraints

### 4.1 A Single Asynchronous Polling Loop

- Start the polling after the first `read()` or the Runtime `start()`;
- The default interval is about 1 second; the test can inject a shorter interval;
- Schedule the next round only after each round completes; do not allow slow IO to cause multiple reads to overlap;
- Use asynchronous file IO and the existing file lock;
- Compare the formal content revision; do not rely on the file name, mtime, size, or inode;
- When the revision does not change, do not publish the Source change, and do not trigger the Registry replace;
- When the read, lock, or parsing temporarily fails, report the observable error, and try again in the next round;
- The Timer must call `unref()` and must not prevent the Node process from exiting;
- Cancel the next round scheduling after the Repository `dispose()`; no event may be published after any in-flight read completes.

Delete the `FSWatcher`, the directory event filtering, the watcher error handler, and the watcher rebuild-related state. The existing `watch?: boolean` if it only expresses the test closing the external change observation, should be changed once to the semantically explicit polling option, without retaining the misleadingly named compatibility layer.

### 4.2 The In-Process Explicit Update Still Publishes Instantly

When the Repository itself executes the `update()`, it continues to update the `observedRevision` and publish one `updated` immediately after the atomic write:

```text
Current Repository.update()
        |
        +-- The atomic write completes
        +-- observedRevision = the new revision
        `-- emit("updated")

The next poll reads the same revision
        `-- Deduplication, does not emit again
```

Therefore, the Host save does not wait a second; only the Repository of other processes catches up at the latest in the next polling round.

## 5. The Connectivity Test Proactively Refreshes

The model connectivity test is the diagnosis of "the configuration already saved" and cannot wait for the next polling round. When the Agent receives the connectivity request, it must first proactively refresh this round's Config Source and the Registry, then find the Provider/Model and test using the formal Model execution chain:

```text
The Host has already completed the save
        |
        v
The Agent connectivity request
        |
        v
The Worker Registry.refresh("provider-connectivity")
├─ Proactively reads the Personal Config
├─ Resolves together with the current Account Config
└─ Waits for the Registry to publish the completion
        |
        v
Find the providerId/modelId by exact lookup
        |
        v
Temporarily create the formal Model and test
```

Do not have the Host directly implement the model HTTP request here: the Host does not own the Adapter/ModelFactory formal execution chain, and copying a connectivity protocol produces the "the test passes but the real chat fails" second behavior. The connectivity test is also not allowed to create a bypass Model from the Renderer draft, the Host Registry Snapshot, or the manually-assembled Provider Config.

When the proactive refresh fails, return the real Config/Registry error; when the Provider is saved but incomplete, it should still fail as the Registry non-executable error; do not bypass the Resolver.

## 6. Normal Operation Semantics

```text
In-process save       --> Immediately refresh the current Registry
Other processes save  --> Catch up within at most about one polling interval
The connectivity test  --> Immediately catch up at the start of the request
New Worker startup    --> The first start/read reads the latest file
The long-term Worker  --> The polling continuously provides the eventual consistency
```

The polling refresh only affects the subsequent Registry lookup and Model creation. Already-created Active Models continue to freeze, without hot-updating their Provider Config, Model Config, Endpoint, or access materials.

The Desktop Local Host, the Web Remote, and the Remote Workspace all comply with the target Environment ownership: the Host and Worker of each Environment only read that Environment's own Personal Config. Do not poll or copy the local Personal Config to the remote Environment.

## 7. Test Plan

Write the failure tests first, then modify the production implementation.

### 7.1 Repository

- Two independent Personal Repositories point to the same file; the writer uses the formal atomic write, and the observer publishes the new revision within one interval;
- Still detects changes without providing any file events;
- The same content, repeated atomic writes, and the in-process `update()` do not produce duplicate notifications;
- The next round does not start before the current round's read completes;
- The file lock, the temporary missing, or the read failure can recover in the next round;
- The `dispose()` cleans up the Timer, and the in-flight read must not emit after the dispose;
- The Timer does not prevent the process from exiting;
- The code no longer contains the Personal Repository's `FSWatcher` or `fs.watch`.

### 7.2 Registry and Connectivity Test

- The Worker Registry parses and publishes the new Provider after the Personal revision changes;
- Test the connectivity immediately after saving the Personal Provider; find the Provider without waiting for the polling interval;
- The existing active Session and the temporary connectivity App both use the refreshed same-process Registry;
- The Config read failure, the incomplete Provider, and the missing Model each retain the accurate error;
- The connectivity proactive refresh does not create a second Registry, the Provider Snapshot, or the test-specific Model DTO;
- The already-created Active Model remains frozen after the Registry refresh.

### 7.3 Regression

- The Account Config continues to synchronize through the existing Protocol, without being merged into the Personal file polling;
- The ZCode Built-in Active/LKG and the remote refresh mechanism remain unchanged;
- The Model Selection, Provider Settings, and normal model requests all see the same Registry fact;
- None of macOS, Windows, or Linux rely on their respective file event implementations.

## 8. Completion Criteria

- The external changes to the Personal Config no longer depend on `fs.watch`;
- The Worker catches up with the new content revision within at most about one polling cycle; the missed events cannot cause permanent staleness;
- The connectivity test always proactively refreshes the current Worker Registry before looking up the model;
- No new cross-process revision protocol, the Config/Registry Snapshot sync, or the Host model execution bypass;
- The targeted tests, the `pnpm typecheck`, the `pnpm lint`, and the macOS real-machine "the connectivity test immediately after saving" pass.

## 9. Implementation Result

- The Personal Repository has deleted the `FSWatcher`, the directory event filtering, and the serial watcher refresh, and changed to the default 1-second, the asynchronous content revision polling that schedules the next round after completing one round; the Timer uses `unref()` and does not publish events after `dispose()`;
- The in-process `update()` still instantly publishes `updated`; the polling reads the same revision and deduplicates; the temporary read failure only reports once when entering the error state, and the subsequent polling continues to retry and can recover on its own;
- The Provider connectivity protocol entry explicitly waits for the current Worker `ProviderRegistryService.refresh("provider-connectivity")` before looking up the Provider/Model and creating the formal Model; no new Host request bypass, Registry Snapshot, or test-specific Model is added;
- The `@zcode/provider-node` 44 tests, the Services Provider Runtime 11 targeted tests, the Bootstrap protocol 108 tests, and the related typecheck pass; the macOS real-machine re-verification is left for the final manual verification stage.
