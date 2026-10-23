# Upstream Sync 3.16.2

Status: in progress. Base `0a1fc56d` (v3.16.1, the current `fork-upstream-base.json` pin). Target `3c5b2276` (v3.16.2, upstream `main`, `Source-Commit: 5a082039`). Method: one real `git merge --no-ff 3c5b2276` into `integration`. `0a1fc56d` is an ancestor of the fork, so git uses the correct three-way base. Do not squash: the merge commit keeps the next sync three-way.

## Scope

The upstream diff `0a1fc56d..3c5b2276` covers 263 files: 35 added, 7 deleted, and 221 modified. 114 of them were also changed by the fork. A dry run (`git merge-tree`) gives 58 conflicted files. The remaining files merge cleanly.

Dependencies do not change. Only the root `package.json` version moves (3.16.1 → 3.16.2). Per `specs/fork-release-versioning.md` the root version follows the upstream base, and fork builds set `-fork.N` at build time.

## Resolution rules

The rules match `specs/desktop-upstream-sync.md`:

- A file the fork did not touch takes upstream (git does this automatically).
- A conflict where the fork side is only comment churn (Chinese → English translation) or formatting takes upstream code. The English comments are kept where the code around them did not change.
- A conflict with real code changes on both sides follows upstream structure, and the fork hunks are re-applied on top. Comments touched in edited code are English.
- A conflict that cannot be resolved without a product decision keeps the fork behavior. It is listed under "Open questions" and is not guessed.
- Migration SQL, ids, and schema baseline strings take upstream verbatim (shared `~/.zcode` databases, `AGENTS.md`). Fork migrations stay `9xxx_fork_*`.

Fork features that must survive the merge: incognito sessions, session deletion cascade and archive permanent erase, worktree open/identity/recovery, deep links (`specs/deeplink-new-task.md`), voice dictation, resource telemetry toggle, bots `/remote`, the self-hosted relay V2, `fork_workspace_pins`, the OAuth callback page, the ACP agent runtime, composer quick prompts, the uk-UA locale, and English e2e copy.

## Database changes in 3.16.2

- Project storage gets a new additive migration step, `packages/services/src/project-storage/migration-order/migration.ts`. It adds `remote_project_entries.initial_position INTEGER` and orders the initial local projects and remote entries from the legacy `lastWorkspaceSession`. `schema.baseline.sql` gets the same column. Both are taken verbatim.
- No other DDL changes.

## Conflict resolution ledger

Filled in while resolving. Each row records the file, the resolution (`upstream`, `merged`, or `fork`), and the fork hunk that was kept.

## 3.16.3 ledger (binary only, not ported)

Upstream released 3.16.3 (build commit `a82dd43e`, 2026-10-23) before publishing its source. The deltas below were inferred from the minified app bundle by comparing string literals against `3c5b2276`. They are not ported, so that no guessed code conflicts with the real source. Port them in the next sync, once upstream publishes 3.16.3.

- No new migrations, no DDL, and no changed migration SQL. 3.16.3 shares `~/.zcode` with this fork safely.
- Electron (41.0.3) and dependency versions are unchanged.
- Remote SSH: new error codes `remote-platform-unsupported`, `remote-authentication-unsupported` (extra verification such as one-time codes), and `remote-workspace-directory-unresponsive` (30 s). Also a minimum glibc 2.28 warning, Windows native shell failure detection, and an "Open project folder" connection step.
- Terminals scoped to an owner window: the host message `set-terminal-owner` and the reconnect reason `terminal-owner-ended`.
- OAuth login fallback "Browser didn't open? Copy login link" (`login.oauth.*`, 4 keys).
- Help menu "Copy device MID" (`workspaceHeader.help.*Mid*`, 3 keys).
- `LocalToolSearch`, a separate tool name for local tool search (`toolSearchNameForMode`). **Risk:** sessions written by stock 3.16.3 may contain `LocalToolSearch` tool parts that this fork's history hydrator does not recognize.
- Project open: the `reuseExistingRoot` option and the `project.invalid-directory-open` error.
- Docker daemon probe and WSL exec error formatting.
- Onboarding eligibility check (`getOnboardingEligibility`).
- The plugin scope labels (`settings.plugins.scope.*`) were removed.
- en-US locale: +15 keys, −5 keys, no value changes.

## Open questions

Filled in while resolving.
