# Unit Test Quality and Pruning Spec

Full history (per-file deletion and slimming tables of rounds 1 and 2): `git show b8876e8b:docs/testing/unit-test-quality.md`.

## Goal and scope

Keep unit tests that can find behavior errors; delete assertions that only lock an implementation spelling and have no independent protective value. The cleanup changes only tests and their coverage/verification docs, never product source, test entry points, architecture policy or E2E code. Deletion ratio, coverage, file length or mock count never decide what stays.

## Pruning criteria

Review per file what the test executes and what its assertions actually prove:

| Type                                                                                              | Handling                                                                              |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Reads component source and checks class strings, attribute order, component or local variable names | Delete pure text guards; they prove no real rendering, layout or interaction          |
| Only checks that an implementation uses a given hook, function call or branch spelling            | Delete when there is no independent behavior evidence; do not replace with another text assertion |
| Test builds its own stand-in and asserts the stand-in returns the preset value without calling the code under test | Delete                                                       |
| Same input, boundary and result already covered by a retained test                                | Merge or delete and record the retained test                                          |
| Actually calls parse, validate or business functions and verifies an independent rule, boundary or failure result | Keep; a short test can have independent value                         |
| Only copies a constant table, icon or label mapping, or display defaults, with no independent rule | Delete the duplicated definition; calling a real function does not automatically give protective value |
| Getter or simple passthrough compared with the same field in the implementation, no boundary wiring verified | Delete unless it has unique contract value; do not add a test per method        |
| Permission, security, protocol compatibility, identity isolation, persistence, races, real IO wiring | Keep the unique protection; never delete just because it uses a mock or reads a file |
| Architecture contracts, release resource manifests, generated artifacts and other static constraints | Review by constraint value; not part of ordinary source-string cleanup                |
| Files mixing source guards and real behavior                                                      | Keep the real behavior; delete low-value cases only when they can be cleanly separated |

- A test written for a historical defect still needs its assertion power checked. Asserting only that source contains a word does not reproduce the defect. Deleting such an assertion does not mean the behavior now has full automation, and no test is forced in for each deleted item.
- A local config test that repeats the whole default catalog must first confirm catalog ownership and independent coverage before narrowing the unrelated part.
- MCP local wiring tests may explicitly exclude only the four built-in documentation servers that have independent verification; they keep one startup, target order, rejection of unknown extra servers, and request identity, user override and retired-server exclusion assertions.
- Architecture-required `contract.test.ts` and existing E2E cases and catalogs are kept; the coverage matrix is edited only to correct invalid unit-test coverage claims.

## Execution and acceptance

1. Record the task start point; finish read-only review and this spec before deleting reviewed tests.
2. Deletion lists give reasons by actual assertions; a mixed file must not be deleted wholesale.
3. Check whether test-to-test imports, run configs and current coverage docs reference deleted files and fix the invalid current references. Historical run records keep their historical meaning and old results are not rewritten as this run's verification.
4. Run root typecheck, lint, changed-file architecture check, format check, and the affected unit tests from the task start point. If affected did not select or skipped the full set, report that honestly; do not claim all retained tests pass.
5. Run the relevant retained behavior tests to verify the cleanup did not break test assembly; do not auto-expand to the full unit suite.
6. Self-check that only tests and docs in the agreed scope changed; commit locally after checks pass.

## Remaining-unit-test per-file review contract

The third round builds the test inventory from `0cd29a0ab4`: Git-tracked TS/JS test/spec files excluding E2E, browser acceptance, fixtures, generated artifacts and third-party copies. Unregistered tests beside sources are included in the quality review; executed counts are still collected per test entry. The inventory was 3578 files, 1069334 lines.

The language-entry recheck found 7 more Go, Python and Kotlin tests (2270 lines), added to `unit-test-review/extra-languages.jsonl`; the full reviewed scope is therefore 3585 files, 1071604 lines. Android instrumentation is device acceptance and not part of this pruning; the empty `action-settler.test` has no source or registered case and is not counted. The original TS/JS inventory count is kept to cross-check the group ledgers.

A scan does not replace review. Each file must be read through its tests, setup and local helpers, together with the implementation or contract of the actual calls under test, and repeated scenarios must be checked for genuinely different input, order or boundary. Large files are read in segments; truncated output, heading lists or import summaries cannot mark a file reviewed.

Per-file ledgers are written in groups under `docs/testing/unit-test-review/`:

- Each record has the file path, content hash at review time, lines actually read, behavior groups covered, implementation evidence and a keep / delete / slim verdict.
- Slimming or deletion lists the specific cases and reasons; a duplicate claim names the retained case and the same-input evidence.
- Mandatory `contract.test.ts` files stay but are still reviewed and recorded; unique security, identity and timing protection is not deleted for simple spelling.
- A partially read mixed file is not recorded as fully done; unclear contracts are investigated further and the ledger is not filled with generic conclusions.
- After each review batch, check the list and collect the cases before deleting; a failed verification is not itself a reason to delete.
- Remaining-unit-test review is complete only when every inventory file has a full semantic review record. Mid-way, report only the completed and remaining counts.

## Cleanup record

### Round 1: source-text guards

2026-10-15, baseline `f540bccfa6`. Three review groups checked assertions one by one; 64 test files deleted and 28 mixed files slimmed. Product source, config, test entries and E2E files unchanged. Vitest collected 608 cases in those 92 files before and 289 after, 319 deleted (1 of them skipped); static `it` counts do not stand in for parameterized expansion.

Verification: root typecheck, lint (210 warnings, 0 errors), changed-file architecture check and format check pass. Affected from the task start selected and ran 28 files, 289/289 pass; three retained config-integrity, parameter-mapping and data-boundary test files pass 87/87. No full unit suite or product E2E run.

Deleted whole files were mostly source-text, class-string, token-literal, icon-name and JSX-spelling guards in `packages/ui/test` (automation, settings, plugin detail, workspace shell, menu radius, dialog radius and similar), plus a few elsewhere: `packages/desktop/test/{cuaHelperOperationsDocs,hostMediaPreviewLogging,rendererMessageHandler}.test.ts`, `packages/provider-node/test/zcode-builtin-map-formatting.test.ts`, `packages/services/test/cuaProducerSurfaceSimplification.test.ts`, `packages/web/test/homeOnlyMediaPreviewService.test.ts`, and `packages/zcode-cua/test/{maas-tool-result-completeness,native/pip-window-chrome}.test.ts`. Mixed files (chart, plugin store, sidebar, share route, web remote-control bootstrap and similar) lost only standalone source/class/assembly string cases; real render, interaction and business-helper cases stayed. The exact lists are in the full-history version.

After deleting text guards such as `rendererMessageHandler` and `workspaceShellRenderStabilitySource`, the corresponding race or render-stability behavior cannot be claimed covered by the old identifier matching. The SL-02 language-label coverage is marked as pending behavior verification in the [language coverage matrix](settings-language-e2e-coverage-matrix.md).

### Round 2: constants, passthroughs and duplicate coverage

Baseline `d027277ea8`. Round 1 did not review the whole library case by case, so its source-text candidate review is not a full quality audit. Round 2 first read the structure of all Git-tracked test-named files, then semantically reviewed candidates and their reference implementations. After excluding E2E and fixtures the index had 3678 files (still containing named E2E and build copies, so not the active unit-test count); root Vitest officially lists 2587 specifications; CLI, docs site, Node-native tests and unregistered tests beside sources were checked at their own entries.

| Review group                                  | Structure-scanned files | Deep-read candidates and references | Scope                                                  |
| --------------------------------------------- | ----------------------- | ----------------------------------- | ------------------------------------------------------ |
| UI                                            | 1193                    | 100                                 | Excludes browser acceptance; includes tests beside sources; keeps contract |
| Services, shared, Provider, Client, RPC       | 590                     | 70                                  | Test-named files of seven packages                     |
| Desktop, CUA, Web, Server, other packages and scripts | 873             | 65                                  | Excludes E2E, fixtures, build copies and mandatory contract |
| CLI                                           | 917                     | 11                                  | Structure scan of all named files; collected per package and per Node-native entry |

The structure scan covers imports, test declarations, mocks, file reads and token-identical callback checks. The deep-read list records only the actually adjudicated scope; for mixed files only the relevant cases and their references are guaranteed reviewed. The round deleted fixed display dictionaries, simple passthrough echoes, self-made algorithm tests, retired leftovers and confirmed duplicate scenarios. In one describe, OAuth, model-protocol and media keep-alive tests with identical callbacks keep one copy without losing their unique boundary coverage. `.test.tsx` not collected by the root config and orphan tests pointing to retired CLI source paths do not count as executed cases.

The docs-site complexity test also failed with `136 != 137` in its original form: the test counted edges to missing nodes as cross-group edges while the implementation counts only valid nodes and valid groups. The rule is kept and verified with independent expectations on a fixed small graph (cross-group, same-group, missing node, missing group); the statistic implementation is not copied, the product algorithm is unchanged, and the test is not deleted because it failed.

Outcome: 59 files deleted and 64 mixed files slimmed; invalid unit-test references in the current coverage matrix corrected. Three source-wiring guards for the official MCP authoritative origin were restored after cross-review: tests with hand-built env cannot replace real assembly constraints. Registered cases dropped from 1104 to 829 (275 deleted); 7 static declarations in two unregistered files were also cleaned and not counted. Two rounds total: 123 test files, 594 registered cases (including the 1 originally skipped from round 1), net 8305 test lines.

Verification: root affected 57 files first passed 721 cases; after restoring the three security guards that file passes 21/21 and the final root retained set is 724. CLI Vitest 70/70, Office profile 1/1, TUI native 33/33, docs-site fixed graph 1/1 pass. Root typecheck, lint (210 warnings) and architecture check pass; CLI typecheck (32 tasks) and lint (68 warnings, 0 errors) pass. The local CLI script lacked the Turbo executable path, so the same task ran from the CLI directory with the lockfile Turbo 2.9.14. Format ran through the root and CLI entries; CUA tests follow the root formatter's existing exclusion. No full unit suite or product E2E; no product source, public protocol, test entry or architecture policy changed.

### Round 3: full-inventory semantic review

Baseline `0cd29a0ab4`. All 3585 inventory files (1071604 test lines) were semantically reviewed one by one, including full setup, local helpers, fixtures and the implementation of the actual calls; large files were read in continuous segments. After four-way collaboration, deletion candidates were rechecked by another reviewer, then cases were collected, applied and run in a targeted way.

| Scope                                  | Files | Raw test lines | Review ledger                                                                                                                                                                                                                      |
| -------------------------------------- | ----: | -------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI                                    |   905 |         376692 | `unit-test-review/cli.jsonl`, `unit-test-review/cli-tail.jsonl`                                                                                                                                                                    |
| UI                                     |  1157 |         296243 | `unit-test-review/ui.jsonl`, `unit-test-review/ui-middle.jsonl`, [ui-tail](unit-test-review/ui-tail.jsonl), [ui-extra](unit-test-review/ui-extra.jsonl), [ui-root-extra](unit-test-review/ui-root-extra.jsonl), [ui-runtime-extra](unit-test-review/ui-runtime-extra.jsonl) |
| Desktop, CUA, Web and other runtime packages | 1141 |       308364 | `unit-test-review/runtime.jsonl`, [runtime-tail](unit-test-review/runtime-tail.jsonl), [runtime-extra](unit-test-review/runtime-extra.jsonl)                                                                                        |
| Services, protocol, Provider, RPC and base scripts | 375 |      88035 | `unit-test-review/foundation.jsonl`                                                                                                                                                                                                |
| Go, Python, Kotlin                     |     7 |           2270 | [extra-languages](unit-test-review/extra-languages.jsonl)                                                                                                                                                                          |

Inventory and ledger cross-check: 3585 records, no duplicate or missing paths; raw hashes and full-text line counts agree one by one; all implementation-evidence paths exist. Another 619 test-named E2E and browser-acceptance files are excluded by scope; native implementations and device fixtures show no extra unit-test entry. Completing the review does not mean everything was deleted; keep reasons are also recorded per file.

Cleanup covered static CSS, icon and plain copy duplicates, unconsumed scenario parameters, stand-in-only echoes, same-input duplicates and over-broad default-catalog assertions. Kept: unique permissions, source identity, timing, IO wiring, protocol schema, caller state assembly and cross-language catalog consistency. The same data attribute does not replace real consumption wiring of dynamic styles.

Some parameterized cases were merged at registration with all inputs and observation points kept. The 537-registration drop in CLI batch 067 is of this kind and is not 537 independent scenarios deleted. Per-item evidence is in the ledgers; judge by it, not by the registration drop ratio.

Outcome: 60 test files deleted, 859 mixed files slimmed, net 25410 test lines removed; product source, config, test entries and E2E untouched. With the previous rounds, 183 test files deleted in total. For the 921 comparison files Vitest actually collected, active registrations dropped from 18542 to 16665 (-1877); this includes parameterized registration merges, excludes Node-native entries, platform skips, Android static declarations and unregistered files. Native entries are verified separately and their static declarations are not passed off as executed cases.

Verification: root and CLI typecheck, lint, changed-file architecture check, and root and CLI changed-file format pass. CLI targeted verification ran 257 existing modified files from the right package directory: 7105 passed, 24 skipped, 0 failed (3 deleted files excluded). The early 13 browser-test failures came from the wrong run directory and 48 passed once run from the core package; 2 SEA failures from a missing build dependency passed (42 all pass) after building model-option-map. MCP keeps all 11 real wiring tests and in four assertions excludes only the default documentation plugin list that has separate verification, keeping target order, one startup, unknown extra server rejection and the full trust check; package-level verification passed at the end.

Root affected used the task start `f540bccfa694da2435227d252bf5c39ab512a34b`; the official preview selected 621/2481 specs; final 620 files passed and 1 skipped, 9938 passed and 10 skipped, 229.19 s. No full unit suite or E2E. Android only deleted a template arithmetic test; Gradle collection and execution did not finish because the environment has no Java Runtime, so that one declaration counts as static deletion only. Retained Go/Python files are unmodified and not claimed executed in this round.

The current coverage matrix has no newly invalid references to deleted files; old plans, historical run reports and this spec's history keep historical paths. Deleting assertions that cannot prove layout, retired behavior or a specific async scenario does not mean those behaviors gained automation.

### Coverage reconciliation after merging staging

Merging staging `65f956a8fc`, unit conflicts were merged by behavior of both sides:

- Keep the upstream MCP startup test split; move the four retained wiring cases of round 3 and the exact documentation-server filter into the new file.
- Keep the new parameter contract of persistent memory, object identity when disabled/unconfigured, idempotency and unchanged-input assertions; keep the new-draft first-frame check and the old send-result isolation regression.
- Keep the sidebar overflow numeric boundary; the old CSS/source-spelling assertions stay deleted. Upstream moved one of them verbatim into `sidePaneTabStripAddMenu.test.ts`; that moved copy and its invalid export exclusion are deleted.
- The upstream edit to `pluginStoreManageEntry.test.ts` only adjusts source location and fixed class checks; the completed whole-file deletion stands and low-value assertions are not reintroduced for a locator fix.
- Browser tests keep upstream's desktop zoom, CDP reconnect after idle disconnect and viewport sync regressions, and keep deleting the old duplicate assertions on constructor parameter passthrough and initial memory count.

The round-3 inventory, statistics and ledger hashes remain a review snapshot of `7c90e96411` and do not represent the inventory of files added after merging.

The merge verification also reproduced a reference-stability failure already on staging: `ProjectTaskRows` created a new JSX reference for `TaskList.organizationActions` on every render, defeating the child's memo comparison. After confirmation it is kept stable with a `useMemo` depending on `task`; the menu still updates when the task object changes, and the menu itself keeps subscribing to the catalog and i18n context. The original failing case passes after the fix with no assertion loosened.

Final merge verification from `7c90e96411`: root affected selected 702/2483 specs; 702 files, 7534 passed, 1 skipped; four targeted CLI files, 36 passed. Root and CLI typecheck, lint, architecture check, database schema check and conflict-file format check pass. Four files that failed to load because the new worktree lacked Electron install artifacts passed on rerun after the artifacts were added. No full unit suite, desktop E2E or open-source export acceptance.

A later staging merge `840d040f57` kept the `@zcode/shared/test-ids` entry migration and the new regressions for concurrent plugin install, MCP connection readiness, session lease release and desktop/mobile Esc authorization. Old class, dictionary-constant and duplicate-assembly assertions in conflicts stay deleted; `pluginStoreManageEntry.test.ts` only had its no-op fixture updated and keeps the whole-file deletion. Root and CLI typecheck, lint, architecture and conflict-file format pass; UI conflict targeted verification 131 passed, CLI targeted 79 passed. Root affected selected 1360/2484 specs and was stopped on request without finishing the whole run; delivery skipped the push hook as requested, and the interrupted run is not recorded as passing.
