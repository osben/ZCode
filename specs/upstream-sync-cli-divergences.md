# Upstream sync: CLI fork divergences

Status: active during the upstream 3.16.1 apps/zcode-cli sync (PRs #201 onward). Each item is a
deliberate difference from upstream 3.16.1 (`0a1fc56d`) that the fork keeps. Remove an item when the
upstream design is adopted or the final sync PR retires the compatibility member.

## Divergences kept by the fork

| Area                             | Upstream 3.16.1                                                                                    | Fork behavior                                                                                                                                                                                                                                                                    | Where                                                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Idle / off-peak Bash background  | Idle turns reuse the explicit and auto-on-timeout background lifecycle                             | Idle turns reject `run_in_background` and never auto-background. A background notification turn runs without the user's `turnExecutionModel`, so it must not run a full agent loop on the user's plan                                                                            | `core/src/tool/handlers/bash.ts`; test `core/tests/bash-handler.test.ts` ("rejects explicit background Bash in idle turns") |
| Tool Search deferral of LSP      | LSP is a regular built-in                                                                          | The LSP tool is `shouldDefer: true` (non-resident under the upstream tool-search rule)                                                                                                                                                                                           | `core/src/tool/handlers/lsp.ts`                                                                                             |
| UI locale in file config         | Unknown locale rejects the whole config file                                                       | Unknown locale is ignored (`.catch(undefined)`), so an older build can read a newer config (`specs/ukrainian-locale.md`)                                                                                                                                                         | `adapters/src/config/schema.ts`; test `adapters/tests/config.test.ts`                                                       |
| Zhipu account fixtures           | Account mode read without a `type` tag                                                             | `zhipuAccountMode` reads only `zhipu-account` access; fixtures carry the tag                                                                                                                                                                                                     | `adapters/src/model/account-access-mode.ts`; test `adapters/tests/runner-options.test.ts`                                   |
| Persisted output style on tests  | Output style is not a persisted operator setting                                                   | `skipUserConfig` also skips the persisted output style and system-prompt override load (the same operator-file exclusion as `createConfig`). Fork-only feature; `docs/output-styles-settings.md`                                                                                 | `bootstrap/src/app/create-app.ts`; test `bootstrap/tests/session-persistence.test.ts`                                       |
| Shared `toolSearchMode` compat   | Host always emits `toolSearchMode`                                                                 | Shared keeps it optional for unsynced Hosts (default `"off"` on parse). Bootstrap resolves a missing value to `"off"`                                                                                                                                                            | `bootstrap/src/zcode-protocol/server-operations.ts`; `shared/src/zcode-protocol/index.ts` (compat comment)                  |
| Incognito resume (CLI)           | No incognito profile in the CLI resume path                                                        | `--resume` reads the frozen incognito profile of the persisted session and passes it along, so an incognito session never resumes as a normal one (fail-closed)                                                                                                                  | `cli/src/resume.ts`; test `cli/tests/resume-incognito.test.ts`; `specs/incognito-session.md`                                |
| ChatGPT plan login (CLI)         | `login` accepts `zai` / `bigmodel` only                                                            | `login chatgpt` runs the ChatGPT plan OAuth flow; `logout` also revokes and clears its credentials; the authorize URL shown in terminal output masks `id_token_hint` / `login_hint`                                                                                              | `cli/src/login-command.ts`, `cli/src/command-center/login-flow.ts`, `cli/src/tui-auth.ts`; `specs/chatgpt-plan-signin.md`   |
| TUI accent palettes              | TUI has only the light / dark built-in theme                                                       | TUI applies the UI accent palette (`palette` in the submit metadata) on top of the built-in tokens; neutral and zai keep the built-in tokens                                                                                                                                     | `tui/src/theme/palettes.ts`, `tui/src/theme/state.ts`; `specs/themes.md`                                                    |
| Ukrainian locale (CLI / TUI)     | Locales are `en-US` and `zh-CN`                                                                    | `uk-UA` is a supported locale; `zh-CN` also carries the ChatGPT login copy so every catalog keeps the same shape                                                                                                                                                                 | `i18n/src/locales/uk-UA.ts`, `i18n/src/locale.ts`; `specs/ukrainian-locale.md`; test `i18n/tests/i18n.test.ts`              |
| Protocol stdin type (CLI)        | `const source = options.input ?? process.stdin` (inferred union)                                   | Annotated as `NodeJS.ReadableStream`. The inferred union of overloaded `on` signatures fails typecheck (TS2349) with `@types/node` 26; runtime unchanged                                                                                                                         | `cli/src/protocol-lifecycle.ts`                                                                                             |
| Seed hash memo (bundled plugins) | `collectFilesystemPluginFiles` reads and SHA-256-hashes every bundled plugin file on each call     | Hashes are memoized per process by exact stat signature (`size:mtimeNs:ctimeNs:ino`). There is a racily-clean 2 s guard and a self-heal on a copy-time hash mismatch (`specs/plugin-discovery-process-cache.md`). The file is listed TEMPORARY in `.staged-file-size-exemptions` | `bootstrap/src/app/bundled-plugins.ts`; test `bootstrap/tests/bundled-plugins-hash-memo.test.ts`                            |
| Dependency pins (CLI / TUI)      | `dotenv` 17.4.2, `react` 19.2.5, `@types/react` 19.2.0, `shiki` ^4.1.0, `ws` 8.18.0, `tsx` ^4.20.0 | Fork chore bumps kept: `dotenv` ^18.0.7 (`459cc1bc`), `react` 19.3.0 / `@types/react` 19.3.0 (`e476849c`), `shiki` ^4.5.0, `ws` ^8.22.0, `tsx` ^4.23.15 (`c642c2ef`, `05763290`)                                                                                                 | `cli/package.json`, `tui/package.json`; lockfile (owned by the lockfile slice)                                              |

- `scripts/verify-project-upgrade.mts` (root script, tracked in the upstream snapshot): upstream opens
  the old-\* phases with `new SqliteSessionStore({ dbPath })`; the fork uses
  `await SqliteSessionStore.open({ dbPath })` for every phase because the constructor is private and
  takes the migration result. Consequence: the old-\* phases no longer exercise a separate
  non-backup open path; they run the same production open (with backup) as the upgrade phase.

## Temporary compatibility members (remove in the final sync PR)

- Removed: `UpdateSessionInput.timeArchived` and session `time.archived` (fork archive column, no
  longer read or written by the port), the `SchemaMigrationRow` re-export in
  `adapters/src/storage/session-store/rows.ts`, `ensureParentDir` in `paths.ts`, and the synchronous
  session-store factories (`createSqliteSessionStore` and `openStartupSqliteSessionStore` are async
  again, as in upstream).
- Removed: `ListSessionsInput.includeArchived` and the `time_archived is null` filters in
  `repositories/sessions.ts` (session listing and the child-session scope), as in upstream. The
  `time_archived` column stays in the schema (inserts write NULL); no DDL, migration id or checksum
  changes. No fork or upstream build has a production writer of `time_archived`: at `872ad960`,
  `aac47556` and `integration`, `updateSession` accepted `timeArchived`, but no caller passed it.
  Data check on 2026-10-21 (read-only, the author's local `~/.zcode/cli/db/db.sqlite`): 5053
  `session` rows, 0 with non-null `time_archived`. A database that did have such rows would now show
  them in `session.list` and the sidebar child counts and lists; the upstream app already shows them
  because it reads the same database without the filter. `scripts/shadow-replay.mjs` no longer passes
  `includeArchived`. The wire fields `session.list.includeArchived` and `session.archivedAt` are
  removed with it (decision and version compatibility: `specs/build-pipeline-entrypoints.md`,
  "Shared-sync compatibility").
- Kept for now: `trimTruncatedUtf8Tail` in `adapters/src/fs/text-metadata.ts` (fork tail trim;
  upstream uses `getUtf8CompletionBytes`).
- Kept for now: `buildEnvInfoSection` argument order — fork's `executionWorktree` third, upstream's
  `additionalDirectories` fourth.
- Kept for now: `ChildSessionFactsResolver.loadStoredFacts` / `ChildSessionRecordView` — fork-only
  bridge helpers (store reads and a structural record view, so `zcode-protocol-v4/` does not import
  the legacy directory).

## Upstream requirements that depend on other packages (slice 3, bootstrap)

- Bundled official plugins declare built runtime artifacts (`dist/server.mjs`, `dist/ui/*` for the
  document plugins; `dist/mcp/server.js` for node-repl-host) in `official-plugin-definitions.ts`.
  Slice 4a (plugin packages and build wiring) builds them: `documents`, `pdf`, `presentations`,
  `spreadsheets` run `packages/office-runtime/scripts/build.mjs`; `node-repl-host` and `browser-use`
  run their `tsc && scripts/build.mjs`. CI builds the same set in the unit job
  (`.github/workflows/pr-checks.yml`, "Build workspace packages needed by unit tests"). Without
  those artifacts the bootstrap tests fail (visualize skill gate, bundled plugin resilience, plugin
  discovery, skill discovery).
- The icon-migration test (`bootstrap/tests/plugins.test.ts`) waits for the mocked `fetch` to start
  before resolving it. The fork loads TLS CA certificates asynchronously (`adapters/src/http`), so
  `fetch` starts after a tick, and the test keeps its synchronous "does not block overview callers"
  assertion.

## Left for the final sync merge (slice 4d: docs/tools/parity)

Slice 4d (`claude/upstream-sync-cli-rest-4d`) took only the files where upstream's change since the
base is the only change, or where the fork's difference from `0a1fc56d` is comment-only and upstream
changed the file. Files that changed on both sides with real code differences stayed on the fork
version there; the final sync PR runs a real `git merge 0a1fc56d`, where git's three-way history
handles the hunks that already landed.

Counts: 156 files with both-side code changes — `packages/core` 77, `packages/bootstrap` 35,
`packages/adapters` 33, `packages/contracts` 8, `package.json` 1, `packages/dynamic-workflow` 1,
`tools/prompt-trajectory` 1 (full list in git history). Comment-only differences from `0a1fc56d` were
not taken, to limit churn: 398 files in total, of which 375 sit in `core`, `bootstrap`, `adapters` or
`contracts` (the fork translated those comments deliberately; 39 of them are files where upstream
also changed comments since the base). Only the two comment-only files outside those packages were
taken (`dynamic-workflow/tests/actor-names.test.ts`,
`tools/prompt-trajectory/src/message-continuity.ts`). The final merge should decide the
protected-package comments together with the code.

Excluded from this slice by the 4a/4b split (plugin packages, `packages/cli`, `packages/tui`,
`packages/i18n`, `cli/scripts/build.mjs`, `cli/scripts/sea-official-plugin-assets.mjs`, lockfile):
not classified here.

### Docs resolved by hand in this slice

| File                                                | Resolution                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `README.md`                                         | Taken from upstream (the fork edit was only the Node version string; upstream rewrote the page).                         |
| `AGENTS.md`                                         | Fork English text kept; the file-size bullet now states the upstream 800-line limit (matches the fork `.oxlintrc.json`). |
| `docs/design/v2/local-setting-migrations.md`        | Three-way merge, clean.                                                                                                  |
| `docs/design/v2/usage-observability.md`             | Three-way merge, clean (fork usage rollup spec kept).                                                                    |
| `docs/design/v2/tool/README.md`                     | Fork item 15 (LSP) kept; upstream ToolSearch added as item 16 (`19-tool-search.md`).                                     |
| `docs/design/v2/tool/00-tool-change-chain.md`       | Both sides kept: fork's 2026-10-17 entries first, then upstream's new entries.                                           |
| `docs/design/v2/model/provider-endpoint-routing.md` | Fork's direct edition table (PER-019..023) kept; upstream's static-gateway table not taken. Fork rule.                   |

## Review

Each item needs the user's confirmation. The bash idle-background rule is the only one that changes
runtime behavior versus upstream's design.

Full history: git show 5df10a43f18201fe2dcfb1c8e1ccea240f50a0ef:specs/upstream-sync-cli-divergences.md
