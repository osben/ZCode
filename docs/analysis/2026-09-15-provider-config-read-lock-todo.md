# Provider Config Pure-Read Lock-Removal

- Status: implemented, regression-tested, and self-reviewed; committed and pushed with an MR to hotfix/3.12.2.
- Feedback: ZCT-2099792881319157760; [Investigation Report](./2026-09-15-provider-config-lock-investigation.md).
- Scope: this pass handles only lock competition. Read failure preserving valid configuration, recovery notifications, and diagnostics are open (see below); settings persistence is not modified.

## Goals and Reasons

Multiple Hosts/Agents read the same Personal configuration about once per second, yet all take exclusive directory locks; pure reads also write and delete lock directory/owner files. Application writes already use same-directory temp files plus rename replacement, so normal readers see the previous or new committed document without waiting for the writer. Normal read also handles Legacy import and format normalization, so the lock of the whole read entry cannot simply be removed.

## Behavior Contract

```text
Explicit read -> no-lock read, decode
              ├─ formal spec file -> return snapshot
              ├─ file missing with no importer -> follow existing empty config behavior
              └─ needs import/normalization -> existing write lock -> re-read latest file -> write-back based on current content

poll -> no-lock read, decode -> compare content version -> follow existing change notifications

update -> existing write lock -> re-read latest file -> transform/validate -> temp file + rename -> updated
```

- `NodePersonalProviderConfigRepository` remains the sole file IO and polling owner; no cross-process read-write lock or additional config cache is added.
- Normal reads and pure polls do not create lock directories, write owners, or wait for another normal writer holding the lock. Explicit reads of unnormalized documents may still wait for the write lock.
- First import, normalization write-back, and modifications re-read inside the original lock; old documents from the no-lock phase must not directly overwrite writes.
- No-lock parsing uses the same decoder, encoder, and content revision as existing reads; schema, migration scripts, and file paths are unchanged.
- Write protocol, queuing, lock budget, lock reclamation, private temp files, and rename retries are unchanged; older writers still using the original lock stay compatible.
- A single poll completes before the next round is scheduled. The `finally` of explicit `read`/`update` cannot schedule a second round while a poll is in flight.
- After a new successful write by this Repository, previously started poll results are discarded, so a late old read cannot regress `observedRevision` or produce duplicate change notifications. Only in-process write generations are used; disk revisions and config sync protocols are unchanged.
- Readers only guarantee observing complete committed versions; no strict cross-process linear reads or pre-send synchronization barriers are added.
- Empty-config degradation after normal read failures, poll-error, and same-version recovery rules are unchanged; this pass reduces trigger sources only and does not claim complete fault recovery.
- Registry, UI, accounts, default selection semantics, and remote sync protocols are unchanged. Default selection, Host/Worker/Standalone reuse this Repository; phones still go through `shared-host`, remotes still use their own Environment; desktop continuous / mobile replayable are unchanged.

## Boundaries and Verification

- Production implementation is limited to `packages/provider-node/src/personal-provider-config-repository.ts`, reusing shared file tools.
- No UI interaction or page structure change; regression tests live at the Repository and real subprocess file IO layers and reuse existing Provider save/default selection/sync tests.
- Verified on Linux natively; Windows/macOS real-machine results must not be replaced by Linux tests. Node/libuv Windows normal file open includes shared-delete capability and rename acts on the replacement target; cross-platform verification still needs to cover concurrent reads and replacement failures. External programs corrupting files in place and permission failures are outside this pass's guarantees.

## Regression Scenarios (covered)

- Another process or writer holds the lock: normal read still reads complete configuration and produces no lock metadata operations.
- Pure polling observes the new version of the formal file while the writer holds the lock, with default fields and rules consistent.
- During first import and normalization queuing, new data saved by another writer is not overwritten by old reads.
- Two processes concurrently saving Provider/default selection preserve both updates.
- Slow poll and explicit read interleaving produce no overlapping polls; late old polls do not overwrite new write versions.
- Bad files and real write failures follow the original error behavior; file content is not corrupted.

## Open: Two Items Requiring Joint Design (Not Implemented)

1. Read failure preserves the last valid Personal data. Clarify the sole owner; distinguish new user with no file, startup never read successfully, runtime failure, valid empty file, file suddenly disappearing. Default selection and rules come from the same snapshot. Saves and remote distribution must verify the real file and not treat an old cache as the latest write basis.
2. Recovery notifications and diagnostics. Distinguish file read recovery from Registry apply completion; converge error states even when content version is unchanged; handle Facade/UI version deduplication, first-start failure not subscribed, concurrent stale results, Environment generation changes. Failure/recovery events are low-frequency; lock queuing/acquire/hold/release are staged; committed-but-release-failed must not masquerade as uncommitted; do not automatically replay user saves; do not leak credentials.

Determine the state model and impact surface for both first, then update spec/tests and implementation; do not advance by catching individual errors one at a time.

## Results

- Production changes limited to the Personal Repository: normal read/poll lock-free; import, normalization, and update keep read-inside-write-lock.
- 10 new IO/concurrency tests, including real subprocess holding the lock during reads, old poll success/error late returns, and ENOSPC save failures. The old implementation failed the lock-holding read test; stale error tests also failed before the fix.
- Focused Repository/Runtime/default-selection/config-service regression: 5 files, 46 tests passed.
- Expanded Provider Node and config distribution regression: 31 files, 277 tests, 276 passed. The sole failure is `zcode-builtin-map-formatting.test.ts`'s built-in Map line-break assertion; that test, `config/provider/zcode-builtin.json`, and `packages/model-option-map` are identical to the hotfix baseline and were not modified.
- `pnpm typecheck`, `pnpm lint` (0 error), `pnpm architecture:check --changed`, and the format check on modified files passed.
- Self-review covered poll-in-flight protection and successful-write generation validation (discarding stale successes and failures) without adding a second config cache.
- Linux file IO and subprocess verification passed; Windows/macOS real machines and desktop/mobile end-to-end were not executed and are not claimed as covered.
- Other real IO faults causing empty-config degradation and same-version recovery notification misses remain unsolved.
