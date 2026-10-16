# Provider Config Pure-Read Lock-Removal TODO

- Status: Implementation, regression, and self-review complete; pushed after commit with an MR to hotfix/3.12.2.
- Feedback: ZCT-2099792881319157760; [Investigation Report](./2026-09-15-provider-config-lock-investigation.md).
- Scope decision: This pass handles only lock competition. Read failure preserving valid configuration, recovery notifications, and diagnostics are designed for tomorrow; settings persistence is not modified.

## Goals and Reasons

Multiple Hosts/Agents read the same Personal configuration by default approximately once per second, yet all participate in exclusive directory locks; pure reads also produce lock directory/owner file writes and deletions. Application writes already use same-directory temp files plus rename replacement; normal readers can observe the previous or new committed document without waiting for the writer to prepare a new file. Normal read also handles Legacy import and format normalization, so the entire read entry's lock cannot be directly removed.

## Behavior Contract for This Pass

```text
Explicit read -> no-lock read, decode
              ├─ formal spec file -> return snapshot
              ├─ file missing with no importer -> follow existing empty config behavior
              └─ needs import/normalization -> existing write lock -> re-read latest file -> write-back based on current content

poll -> no-lock read, decode -> compare content version -> follow existing change notifications

update -> existing write lock -> re-read latest file -> transform/validate -> temp file + rename -> updated
```

- `NodePersonalProviderConfigRepository` remains the sole file IO and polling owner; no cross-process read-write lock or additional config cache is added.
- Normal reads and pure polls do not create lock directories, do not write owners, and do not wait for another normal writer holding the lock; explicit reads of unnormalized documents may still wait for the write lock.
- First import, normalization write-back, and modifications must re-read inside the original lock; old documents in the no-lock phase must not be used to overwrite writes directly.
- No-lock parsing uses the exact same decoder, encoder, and content revision as existing reads; schema, migration scripts, and file paths are not modified.
- Write protocol, queuing, lock budget, lock reclamation, private temp files, and rename retries remain unchanged; older version writers still using the original lock remain compatible.
- A single poll completes before scheduling the next round. The `finally` of explicit `read`/`update` cannot schedule a second round while a poll is in flight.
- When this Repository has a new successful write, discard previously started poll results to avoid old reads returning late and causing `observedRevision` to regress and generating duplicate change notifications. Use only in-process write generations; do not modify disk revisions or add new config sync protocols.
- Readers only guarantee observing complete committed versions; no strict cross-process linear reads or pre-send synchronization barriers are added.
- Empty config degradation after normal read failures, poll-error, and same-version recovery rules remain unchanged; this pass reduces trigger sources only, not claiming complete fault recovery.
- Registry, UI, accounts, default selection semantics, or remote sync protocols are not modified. Default selection, Host/Worker/Standalone reuse this Repository; phones still go through `shared-host`, remotes still use their belonging Environment; desktop continuous / mobile replayable remain unchanged.

## Boundaries and Verification

- Production implementation is limited to `packages/provider-node/src/personal-provider-config-repository.ts`, reusing shared common file tools.
- No UI interaction or page structure modifications; regression tests are placed at the Repository and real subprocess file IO layers, reusing existing Provider save/default selection/sync tests.
- Linux native environment verification; Windows/macOS real-machine results must not be substituted with Linux tests. Node/libuv Windows normal file open includes shared-delete capability,
  rename uses the operation on the replacement target file; cross-platform verification still needs to cover concurrent reads and replacement failures. External programs corrupting files in place and permission failures are not within this pass's guarantees.

## Execution TODO

- [x] Clarified locking competition and necessary concurrency boundaries only; last two items deferred to joint design.
- [x] Saved this behavior contract, verification scenarios, and subsequent joint design todos to disk.
- [x] Added regression tests first, and confirmed old implementation failed.
  - Another process or writer holding the lock: normal read still reads complete configuration; no lock metadata operations produced.
  - Pure polling can observe the new version of the formal file while the writer holds the lock, keeping default fields and rules consistent.
  - During first import and normalization queuing, new data saved by another writer is not overwritten by old reads.
  - Two processes concurrently saving Provider/default selection continue to fully preserve both updates.
  - Slow poll and explicit read interleaving do not produce overlapping polls; late-arriving old polls do not overwrite new write versions.
  - Bad files and real write failures follow the original error behavior; file content is not corrupted.
- [x] Implemented pure-read and write-back branching, with Chinese-language reason comments added.
- [x] Ran focused regressions, related existing tests, typecheck, lint, format check, and architecture gate.
- [x] Self-reviewed actual diff, recorded test and platform limitations, submitted as an independent commit.

## Two Items That Must Be Jointly Designed Tomorrow (Not Implemented Here)

1. Read failure preserves the last valid Personal data: clarify the sole owner; distinguish new user with no file, startup never read successfully, runtime failure, valid empty file, file suddenly disappearing; default selection and rules come from the same snapshot; saves and remote distribution must verify the real file, not treat old cache as the latest write basis.
2. Recovery notifications and diagnostics: distinguish file read recovery from Registry app completion; converge error states even when content version is unchanged; handle Facade/UI version deduplication, first start failure not subscribed, concurrent stale results, Environment generation changes; failure/recovery events are low-frequency, lock queuing/acquire/hold/release are staged, committed-but-release-failed must not masquerade as uncommitted; do not automatically replay user saves, do not leak credentials.

These two items first jointly determine the state model and impact surface, then update spec/tests and implementation, not advancing by catching individual errors one at a time.

## Execution Results of This Pass

- Production changes limited to Personal Repository: normal read/poll lock-removed; import, normalization, and update retain read-inside-write-lock.
- 10 new IO/concurrency tests added, including real subprocess holding lock reads, old poll success/error late returns, and ENOSPC save failures. The old implementation's lock-holding read test was confirmed failed; stale error tests were also confirmed failed before fix.
- Focused on Repository/Runtime/default-selection/config-service regression: 5 files, 46 tests passed.
- Expanded Provider Node and config distribution regression: 31 files, 277 tests with 276 passed. The sole failure is `zcode-builtin-map-formatting.test.ts`'s built-in Map line-break assertion; the corresponding test, `config/provider/zcode-builtin.json`, and `packages/model-option-map` are identical to the hotfix baseline; not modified this pass.
- `pnpm typecheck`, `pnpm lint` (0 error), `pnpm architecture:check --changed` passed; modified file format check passed.
- Self-review completed poll-in-flight protection and successful write generation validation (simultaneously discarding stale successes and failures), without adding a second config cache.
- Linux file IO and subprocess verification passed; Windows/macOS real machines, desktop/mobile end-to-end not executed, not claimed as covered.
- This pass does not solve other real IO faults causing empty config degradation or same-version recovery notification misses.
