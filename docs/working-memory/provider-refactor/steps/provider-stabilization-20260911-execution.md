# Provider Stabilization: Execution Ledger for This Round's 19 Items

> 2026-09-11. The user authorized Goal execution, item-by-item review and a final push of the current branch. Baseline `1bc2e9bc42`, branch `provider-stabilization-20260911`, independent worktree.
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/provider-stabilization-20260911-execution.md`

## Goal, Scope and Conventions

Execute all 19 items (Todo113 round two and Todo115-132), using each Todo's latest decision as the specification (do not
restore revoked behavior from old comments). The original "only persisted / not authorized for implementation" wording
is kept as history; this round authorizes execution. Todo120 still focuses on signature-equivalent acceptance: if a
modification is found, give evidence first and do not redo the signature system.

1. Spec and failing tests first, then implementation. Check requirements, upstream/downstream, Provider/Selection
   abstractions and data boundaries per item and record evidence before proceeding; items with shared code may be
   implemented and reviewed in one group, with shared build/typecheck/lint/E2E run in batches.
2. Record single-point environment/test pre-existing issues and move them to independent items; do not rerun large
   regressions without added proof value; distinguish merge/this-round regressions, existing product issues and
   outdated tests; do not fix unrelated issues.
3. A new product decision, significantly expanded architecture, real user data or a new permission request suspends only
   the related matter. Unresolved key requirements are never written as completed; previously unverified Todo102 cannot
   bypass this round's acceptance.
4. Built-in accounts cannot be disabled; manual-Key instances created from a template can be enabled or disabled;
   qualification is still judged by public facts. Telemetry restores the old caliber as far as possible; reports and
   actual identity are unchanged.
5. Old fields and content are retained; rollback or re-upgrade may discard model selection but content stays readable
   and must not break on missing new fields. First migration never overwrites already-migrated personal intent; the 0020
   checksum is unchanged.
6. One config fact source, one formal execution chain; a bound Model is frozen; drafts/history are not written; no
   secret model replacement. Desktop continuous, mobile replayable/shared-host and workspace identity isolation stay.
7. The final intersection review, key regressions and commit are pushed to the current branch; no automatic online
   config release, no automatic MR, no push of other workers' branches.

## Items and Outcome

All 19 items were implemented, or the original implementation was verified and reviewed item by item; batch-local
tests, build and intersection review are done. The 2026-09-12 Pro supplement added real Electron cold recovery,
settings save/recovery and Chinese display verification; remaining mobile/SSH acceptance stays unclaimed, so full-end
acceptance is not announced. Delivery details, commits and limitations: [Final Review](./provider-stabilization-20260911-final-review.md).

| Todo | Topic                                                                | Implementation / verification / review                                                                         |
| ---- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 118  | First-migration manual Provider enable/disable                       | Implementation, test and joint review with 117 passed                                                          |
| 121  | Supplement Session reasoning tier                                    | Implementation, formal migration/Reader test passed                                                            |
| 117  | Account domain, plan selection, disabled-account cancellation        | Implementation, 503 batch unit tests, 4 browser cases, review passed; real multi-end chain untested            |
| 115  | Provider title bar and hit area                                      | 109 batch unit tests, 6 browser cases passed                                                                   |
| 132  | Name confirmation save and option background color                   | Batch unit test/browser and screenshot review passed                                                           |
| 119  | Connectivity test green feedback and name                            | Unit test/browser passed                                                                                       |
| 124  | Disabled test entry and prompt                                       | Unit test/browser passed                                                                                       |
| 116  | Single Key URL full acceptance                                       | Full-chain review, 49 unit tests, batch browser and Pro native open passed; real mobile login console untested |
| 130  | Manual field contract                                                | 498 batch unit tests, real Repository round-trip, 2 browser cases passed                                       |
| 131  | Smart placement and recovery                                         | Atomic recovery/old-request-failure browser, unit test passed; Electron file interaction later supplemented on Pro |
| 125  | Question-mark description                                            | 9-item final implementation, dual-size help interaction/geometry passed; Linux Chinese-character limitation kept |
| 126  | GLM vision badge, Flash PDF, Turbo default                           | 96 unit tests, 2 dual-entry browser cases passed; not yet published online                                     |
| 113  | Round two directory and smart configuration                          | Research, verified directory/rules/SDK implementation passed; unconfirmed supply limitation kept               |
| 128  | Lifecycle and idle qualification                                     | 80 targeted tests, 1 real Hook browser case passed; Air real-team acceptance pending                           |
| 127  | Built-in online release chain                                        | Download/Account/lifecycle, Pro settings refresh -> new request full chain, macOS HTTP/dual-process, final revision22 integrity passed; mobile/SSH and online release limitation kept |
| 129  | Team classification and old telemetry ID                             | 229 batch unit tests, real home-page component browser case passed                                            |
| 122  | Subagent error details                                               | 84 Core tests, 2 detail/copy browser cases passed; the unlocated startup root cause is excluded                |
| 123  | History capacity query                                               | 12 new tests, batch gate, Pro Electron CW01-CW06 passed; 5 baseline failures recorded separately               |
| 120  | Official URL signature-equivalent acceptance                         | 32 paired / 147 batch tests passed; both official services each have two entries' real Sig/200/text; Air remote independent package limitation kept |

## Verification Notes

- Opening freshness passed; no upstream tracking branch (the final push sets it). Initial architecture check: 0
  violations. Services is an unmanaged module with a generated direct-dependency contract; the first item keeps the
  existing migration entry and adds no cross-layer dependency.
- Credentials are never written to documents, printed or committed; real user files are not modified; other working
  trees unchanged.

### Todo118: first migration

Expanded real old file -> import -> Repository -> Resolver -> save-reopen cases; outer false/true, the zcode.enabled
conflict, extension false and default are verified separately (before the fix, explicit enable/disable was lost in
the new rule: 3 distinguishing failures; also corrected a test that accessed the non-existent
`ResolvedProvider.executable` since execution qualification should check the model and the actual Registry member).
The implementation copies only the explicit `enabled` to the outer layer of the Provider rule in the custom branch (the
default is not materialized); old built-in API migrates only the Key, account identity skips, and model/Key/order/
context are unchanged; the runtime Resolver and normal reading are not modified. 3 migration files / 20 tests pass
including a real temp-directory round-trip; old `config.json` stays byte-identical, post-upgrade enable/disable edits
persist and are not imported again. Account disable cancellation is jointly accepted with Todo117; type/lint and
negative qualification examples were consolidated in the batch gate.

### Todo121: append migration and first gates

Migration 0022 was appended (19 failing cases red first, then green with the old full-library migration and the GLM
migration; 29 tests pass); 0020/0021 and table/column structure are untouched. The formal runner and Reader prove the
two upgrade paths, conservative skip, original content/time retention, failure rollback and no re-run. Root typecheck
passed; root lint 0 errors / 41 warnings; Adapter typecheck passed; architecture 0 violations. Full Adapter lint did
**not** pass (multiple max-lines errors including `migrations.ts`, which already exceeded the limit before; only the
registration item was appended; the new 0022 file passes individual lint); unrelated long files were not expanded and
the final gate must distinguish existing errors from new ones. Logs:
`/tmp/provider-stabilization-20260911-{typecheck,lint,adapters-typecheck,adapters-lint}.log`. An earlier wrong
architecture module name `cli-adapters` was corrected to the actual `zcode-cli` (no policy or baseline change).
