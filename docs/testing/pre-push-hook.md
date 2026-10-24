# Pre-push Hook

Husky owns Git's `pre-push`.

- After dependencies are installed, the root script `pnpm prepare` runs and installs Husky.
- `pre-push` runs `pnpm run verify:pre-push`.
- Root `pnpm test` runs unit tests only; it does not treat desktop `packages/desktop/test/e2e` as Vitest cases.
- The E2E exclude glob in the unit-test script must be quoted. Otherwise the shell expands `packages/desktop/test/e2e/**/*.test.ts` into real files, Vitest treats the extra files as filters while also excluding them, and reports `No test files found`, which blocks the push.
- `verify:pre-push` runs lint, the architecture check and the affected unit tests of the push range in turn; a failure of lint, the architecture check, the selected tests or the script itself blocks the push.

This catches obvious problems with fast static checks before code reaches the remote, then catches unit-test problems locally, while `pnpm test:e2e` stays the separate entry for desktop E2E.

<a id="开发环境与版本管理工具"></a>

## Development Environment and Version Managers

pre-push uses the pnpm / Node on the current `PATH` and does not require mise. The earlier outer `mise exec` of the hook could pick a specified version, but forced developers who prepared their environment with nvm or similar to install mise too, or the checks failed before starting.

```text
developer prepares Node / pnpm (mise, nvm or other)
    → Git hook keeps push ref info and cleans the Git local env
    → pnpm run verify:pre-push
    → lint / architecture check / affected unit tests
```

- The repository declares tool versions and runs the checks; the personal environment makes a suitable Node / pnpm findable by Git.
- mise stays an optional development entry; `mise.toml`, `mise-run.mjs` and the existing child-process PATH protection are unchanged.
- If a GUI Git client cannot find Node / pnpm, initialize your own version-manager environment in the personal `~/.config/husky/init.sh`; see the [Husky docs](https://typicode.github.io/husky/how-to.html#node-version-managers-and-guis).
- A missing command or a failed check still blocks the push; the hook does not install tools and does not silently skip checks.
- The hook only drops its dependency on mise; it adds no version check and changes no existing development, CLI/SEA or CI version requirement.

## Affected Unit Tests

### Goal and entries

`pnpm test:unit:affected` uses Vitest's official changed/related and Vite module dependency analysis. The thin entry only handles the Git baseline, the Push worktree check, the full-suite skip and result messages; it maintains no own dependency graph, baseline consumer graph, source filtering or Node test selection.

| Entry                                        | Official selection scope                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `pnpm test:unit:affected`                    | `changed: true`, including staged, unstaged and untracked files                                                    |
| `pnpm test:unit:affected --base <commit>`    | `changed: <SHA>`, including commits after the task start and current uncommitted changes                          |
| `pnpm test:unit:affected --scope push`       | Explicit baseline first; by default the hook remote SHA, and for a first push the merge-base of HEAD and origin/staging |
| `pnpm test:unit:affected --files <files...>` | Official related, for explicit file entries such as lint-staged                                                   |
| The above plus `--dry-run` / `--dry-run --json` | Preview the officially selected test files; JSON contains only the test list                                   |

The task records HEAD SHA once at the start and uses that start at the end. Uncommitted changes that existed before the start are all included; no initial patch is saved or subtracted. Official changed uses Git's three-dot comparison and current uncommitted files; changes brought in by a merge take part in selection normally, with no source filtering or extra net-diff computation.

Push requires staged, unstaged and untracked changes to be empty (files ignored by Git are ignored). When not clean it exits non-zero, without auto-stash or creating a checkout, so what runs is the pushed version. A non-delete hook ref must point to the current HEAD; for multiple refs the official selection is called with each baseline and the exact test specs are merged. A delete ref needs no tests. In manual push mode without hook input, upstream is used; without a valid upstream, the merge-base of origin/staging. No usable baseline, an invalid remote SHA that needs to be used, or a target that is not HEAD all exit non-zero. An explicit baseline takes priority over the hook remote SHA; without an explicit baseline the baseline of a new branch uses only origin/staging and guesses no other branch.

In all modes the baseline priority is `--base` → `ZCODE_AFFECTED_TEST_BASE` → `ZCODE_PRE_PUSH_BASE` → the scenario default baseline. `ZCODE_AFFECTED_TEST_BASE=<ref> git push` hands the resolved SHA of the given branch, tag or commit to Vitest changed; branch names like staging are not hardcoded. Even with a specified baseline, Push still requires a clean worktree and a non-delete target equal to HEAD. An invalid explicit baseline is an error and does not fall back to the remote SHA.

The default worktree mode does not read upstream when there is no explicit baseline. `--files` / `--files-manifest` use official related and are not mixed with `--base` or push.

### Selection and execution

```text
scenario and baseline → Push worktree check → Vitest official selection → compare with full root UT specs
                                                     ├─ 0: message, exit 0
                                                     ├─ partial: run the same spec list
                                                     └─ all: explain why, skip UT, exit 0
```

- Granularity is the test file; once a file is selected all cases in it run. The projects included by the root config form the whole root UT suite, excluding desktop E2E and the standalone CLI tests; Node native tests under scripts run separately with node --test and are not linked automatically.
- Selection uses the public getRelevantTestSpecifications; globTestSpecifications supplies the full list. Preview only transforms modules, without collecting/importing tests; execution uses the same Vitest instance and the same exact specs, so CLI file-name substring matching cannot widen the scope.
- Official forceRerunTriggers keeps its default config, adds the config-file pattern `**/{vitest,vite}.config.*` (the current default glob's trailing `/**` misses some config files), and adds the shared vitest.setup.ts. Reason: official module dependency analysis does not additionally include setupFiles; a change to the shared setup must count as a full-suite impact, which the entry explains and skips UT, exiting successfully.
- Full means the complete suite was selected (specs identified by project/pool/path), not an arbitrary count threshold. A large number of really related tests that do not cover the complete suite run as usual. Even in dry-run / JSON, selecting the whole non-empty suite is explained and exits successfully, and does not block Push.
- With no selected tests it explains and exits 0; this does not mean all changes are verified. Limits of official dependency detection apply as is, with no own compensation such as literal file reads, type dependencies or deleted-file baselines.
- Selection precision depends on an accurate module graph, not on selection rules: official selection is a file-level transitive closure, and `export *` through a barrel passes one module's change to every test importing the barrel. High-fan-in pure-constant modules therefore go only through sub-paths, not the root barrel. The constants of `packages/shared/src/test-ids.ts` are imported only from `@zcode/shared/test-ids`; the root entry no longer re-exports them and importing them from the root entry is rejected by typecheck; the workflow family `test-ids-workflow.ts` is still exported by the root entry and is outside this rule. Reason: the root entry aggregates 100+ `export *`, and changing test-ids once selected 1379/2638 tests, of which about 50 reference test-ids directly.
- A test failure exits 1; Git, argument, baseline and Vitest errors and a dirty worktree exit 2; a full-suite skip exits 0 and does not mean the tests passed. It never falls back to the full suite automatically, never adds a full-suite retry, and never silently swallows selector exceptions. pnpm test / pnpm test:unit stay the explicit full entries.
- Output shows the selected count and baseline; when the full suite is skipped it explains that official selection chose the whole suite and lists the officially related changed files. dry-run lists exact specs and JSON contains runner/project/pool/path, without inventing per-file relation reasons.
- Git/file operations are async; hook local env cleaning and the lint-staged JSON manifest are kept, so Windows does not expand file names through a shell. The worktree and index are not modified.

The full-suite skip applies to the worktree, task end, Push and explicit file entries. In Push, a failing lint, architecture check, dirty worktree, baseline or an actual partial test failure still blocks the push; the skip only lets the affected-UT item through and does not mean the tests passed.

### Regression acceptance

Verified with a temporary Git repository, real Vitest and command entries: partial selection consistent between preview and execution, unselected files not run, tasks spanning commits and old WIP, newly added tests, config and shared setup full-suite skip, common-dependency full-suite skip, a real git push succeeding after a full-suite skip, no-relation successful exit, test failure, invalid baseline, first/existing-branch Push, dirty worktree and non-HEAD push blocked, multiple refs and delete refs, integration merges taking part in selection normally, lint-staged manifest and Git local env isolation. The fixture removes the outer push/baseline environment before injecting the scenario's own parameters, so the real repository's SHAs do not pollute the temporary repo.

### Timing and real child-process tests

- Timing algorithms are verified with a controlled clock and data events for ordering; real IO wiring keeps separate integration coverage, and process-start queueing is not counted into very short algorithm test windows.
- Close tests with real child processes first wait for the ready event the fixture emits after registering its exit handler, then start the close timer; a fixed sleep does not prove the child is ready.
- Integration tests that must start an independent Node within a short window, show service process trees or use native dependencies go into the `fork-isolated` group of `vitest.config.ts`. That group runs file by file serially after the ordinary tests; real processes, original assertions and timeout values are kept, and no case is skipped.
- The CI shell integration test for remote-control frontend source selection starts Git, Bash and Node in a row; it belongs to the serial group above and keeps the real source selection, build wiring, cleanup verification and the original 30-second timeout.
- Native file-watching integration tests also verify real event delivery in the serial group; notification dedup and event order are verified separately with controlled watcher events, so logic assertions are not bound to system event scheduling. Gen UI state covers external writes, duplicate file events, same-value write ACK, and still receiving notifications after reading the latest state.
- Normal completion asserts the exit code, `timedOut: false` and `aborted: false` together. Cancel or deadline must not treat a signal exit as success; resource-cleanup assertions must confirm only the resources created by this run are removed.

```text
ordinary unit (controlled events/clock) → fork-isolated (real process, single file serial)
                                     └─ normal end / cancel / deadline → check state and resource cleanup
```

### CLI native test environment

affected selects only the root Vitest UT; tool Node tests run separately and do not replace the CLI's native `pnpm --filter zcode-cli test`. The CLI's CUA sync test locates the producer checkout with the explicitly passed `ZCODE_CUA_REPO`; the Turbo test task includes it in the cache key and passes it to the test; no local absolute path is recorded and the producer pin is not changed. `VITEST_MAX_WORKERS` is passed through and part of the cache key likewise, so a resource-limited full verification can limit single-suite concurrency explicitly; timeouts must not be enlarged to mask assertion failures.

The CLI full entry builds the root workspace `@zcode/model-option-map` through pretest, so SEA tests can read runtime resources from a clean checkout; they must not depend on a previously hand-built dist.
