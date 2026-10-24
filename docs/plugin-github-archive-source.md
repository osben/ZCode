# Public GitHub plugin source install without Git

## Status

- Date: 2026-08-06, baseline `origin/staging`.
- Decision: anonymously readable GitHub HTTPS sources use GitHub Archive first; no Git is bundled into Desktop or Agent packages.

## Problem and root cause

Marketplace and plugin entry sources `github`, `git`, legacy `url`, and `git-subdir` all end in `execFile("git", ...)`, so plugin management implicitly requires Git on the machine running the ZCode Agent:

- Desktop local workspaces need the local machine's Git;
- the standalone CLI needs Git on the CLI host;
- SSH, WSL, and Docker workspaces need Git inside the remote Agent Host, not in Desktop.

Startup discovery, enable/disable, and session injection of installed plugins read only the local installed cache and need no Git. The gap is in the "remote source materialization" boundary and must not be patched with special cases in the UI, Desktop main, or the relay.

## Goals

1. All anonymously readable `github.com` HTTPS Marketplace and plugin sources keep working — refresh, validate, describe, install, update — on machines without Git.
2. GitHub Archive shares the download, rate-limit, safe-extract, and proxy machinery with explicit ZIP, but the two integrity semantics stay distinct: explicit ZIP verifies `sha256`; GitHub Archive binds to Git `sha` / `commit` / `ref`.
3. Marketplace snapshots and installed plugin caches always keep one complete, offline-readable old version across failures, cancellation, and process crashes.
4. Batch refresh isolates failures per Marketplace: one failing source never blocks others and never deletes the last successful snapshot.
5. Private repos, SSH, non-GitHub Git services, and sources needing advanced Git semantics keep using system Git; without Git they return structured, actionable diagnostics.
6. One adapter implementation works on macOS, Windows, Linux, and in Desktop local, standalone CLI, and SSH/WSL/Docker Agent Hosts.

## Non-goals

- No bundled or downloaded Git executable; no libgit2/isomorphic-git.
- No new credential protocol for private GitHub tokens / SSH keys.
- No changes to plugin enable, hook trust, MCP, Skill, Subagent, or session injection semantics.
- No plugin business state sinks into Desktop main, the remote relay, or mobile.
- No cross-JSON/directory distributed transaction: each replaced target uses a same-directory recovery marker plus a deterministic backup, recovering the commit window before the next state load or plugin discovery.

## Target flow

```text
Settings / CLI command
        |
        v
plugins protocol -> workspace Agent Host (local / SSH / WSL / Docker)
        |
        v
source classifier
        |
        +-- public github.com HTTPS / github shorthand
        |       |
        |       v
        |   pin = sha/commit > ref > HEAD
        |       |
        |       v
        |   GitHub Archive REST zipball (HTTPS -> codeload redirect)
        |       |
        |       v
        |   bounded download -> secure extract -> semantic validation
        |
        +-- private/auth/SSH/non-GitHub/submodule/LFS
                |
                v
             system Git
                |
                +-- unavailable -> structured actionable diagnostic

validated source tree
        |
        v
same-volume staging copy
        |
        v
write transaction marker
        |
        v
target -> backup ; staging -> target ; authority JSON writes transactionId
        |                         |                    |
        +------ failure ----------+--> backup -> target rollback
                                                   |
                                                   v
                                  finalize removes backup + marker
        |
        +------ process exit -----> next read cross-checks authority generation

startup / discovery / enable / session injection
        |
        +----------------------------> installed cache only (no HTTP, no Git)
```

## Source classification and pinning

### GitHub Archive candidates

These sources use Archive first, provided the repo URL normalizes to `https://github.com/<owner>/<repo>[.git]` and the Marketplace does not declare `sparsePaths`:

- Marketplace `{source:"github", repo, ref?, path?}`;
- Marketplace `{source:"git", url, ref?, path?}`;
- plugin entry `{source:"github"}`, `{source:"git"}`, `{source:"url"}`, `{source:"url", type:"git"}`, `{source:"git-subdir"}`.

Only HTTPS URLs on `github.com` / `www.github.com` and `owner/repo` shorthand qualify. SSH, `git://`, URLs with userinfo, and other hosts never route to Archive. The repo URL must parse to exactly owner and repo; extra tree/blob page paths are rejected.

Archive ref selection is fixed:

```text
source.sha || source.commit || source.ref || "HEAD"
```

`sha` / `commit` are Git object identities; `ref` and `HEAD` can move on the remote. None equals the ZIP byte SHA-256 — never write or reuse the `sha256` field for them.

### System Git routing

These sources keep system Git:

- SSH, non-GitHub hosts, URLs with credentials or requiring auth;
- Marketplaces declaring `sparsePaths`: Archive has no equivalent of Git sparse checkout path projection yet, and downloading the whole repo would break existing large-repo usability;
- Archive answering 401, 403, or 404 — possibly a private or non-anonymously-readable repo;
- the extracted target path depends on submodules, or plugin files are Git LFS pointers;
- legacy sources that cannot be normalized to a GitHub repo safely and unambiguously.

Archive timeouts, connection failures, 5xx, rate limits, or security validation failures do not fall back to Git, so the same network/malicious-package error is not re-executed on an unpredictable path. Only the "needs Git semantics/auth" classification falls back.

When system Git is missing, the diagnostic code is `plugin_git_unavailable`; the message must state the source, why it needs Git, and recovery options (install Git on the current Agent Host, or switch to a public GitHub HTTPS / explicit ZIP source).

## Download and extraction safety

GitHub Archive uses the official `repos/{owner}/{repo}/zipball/{ref}` REST endpoint and reuses the underlying HTTP ZIP materializer from `zip-source.ts`:

- HTTPS only on the remote; loopback HTTP only for test fixtures;
- the unified proxy/CA/NO_PROXY network environment;
- at most 5 redirects; custom headers are not forwarded across origins;
- archive at most 100 MB compressed, 250 MB extracted, 20,000 entries, 50 MB per file;
- zip-slip, absolute paths, symlinks, and special files are rejected;
- GitHub Archive strips the single top-level directory and resolves the plugin or Marketplace `path` inside it;
- `sparsePaths` stays out of Archive routing and keeps system Git sparse checkout.

Explicit `{source:"url", type:"zip"}` still requires `sha256`. GitHub Archive does not require an archive SHA-256, but when the source provides a commit pin, the download URL must bind to that commit.

## Atomic cache activation

Marketplace snapshots and installed plugin caches share this directory commit protocol:

```text
prepare:  target parent/.<name>.stage-XXXXXX
validate: manifest, target path, version, and compatibility checks pass inside the stage
intent:   write .<name>.transaction.json (owner + transactionId + authorityPath)
commit:   target -> .<name>.backup
          stage  -> target
state:    known/installed JSON record the same cacheTransactionId
cleanup:  delete backup and transaction marker
rollback: backup -> target if the second rename fails
recovery: if authority carries the transactionId keep target, otherwise restore backup
```

- staging and target share one parent directory, so renames never cross filesystems;
- the backup name is deterministic; the transaction marker records the same-directory stage name, process owner, transactionId, and the authority state file; recovery code refuses to clean paths not matching the target prefix;
- cancel before commit: delete the staging, old target untouched;
- once commit starts, cancellation is no longer treated as failure — activation and state recording complete, avoiding "new directory live but installed record missing";
- cleanup failure only logs/appends a diagnostic and never rolls back a successful new version;
- while the owner is still alive, plain reads do not run recovery: before the authority records the transactionId they read the backup, after it the target — so overview/runtime discovery neither steals the writer's rollback resources nor sees cross-generation state;
- after process exit, recovery reads use the same `cacheTransactionId` in `known_marketplaces.json` / `installed_plugins.json` as the commit criterion: present means keep the new target; absent means restore the old backup (for a first install, remove the uncommitted new target);
- JSON state files use same-directory atomic replace where rename-over is supported; on Windows, when the target exists, the same deterministic backup + read-time recovery protocol applies;
- every synchronized read entry for `known_marketplaces.json`, `installed_plugins.json`, the Marketplace manifest, and the installed cache parses the readable generation, so an active commit or a process-exit window is never interpreted as the source or plugin being deleted;
- Marketplace refresh fully loads and validates the source before activating a snapshot; any download/parse error leaves the old snapshot untouched.

## Marketplace refresh state

`KnownMarketplaceRecord` gains optional `lastRefreshFailure`:

```ts
interface MarketplaceRefreshFailure {
  code: "plugin_git_unavailable" | "plugin_archive_fetch_failed" | "plugin_marketplace_invalid";
  message: string;
  failedAt: string;
}
```

- Single-marketplace refresh failure: save the failure, keep the old `lastUpdated`, `pluginCount`, and snapshot.
- Batch refresh: keep refreshing other marketplaces, returning successful summaries plus failure diagnostics.
- Next success: clear `lastRefreshFailure`, update `lastUpdated`.
- `plugins/overview` returns the failure so the UI can show it after reload/restart instead of a one-shot toast.
- The installed cache is separate from Marketplace availability: a failing or removed source does not affect installed plugins running.

## Protocol and UI behavior

- `zcodePluginMarketplaceSummarySchema` gains optional `refreshFailure`, without breaking older Agent payloads.
- `plugins/marketplace/update` returns partial failures through the existing optional `diagnostics`.
- The UI update operation must check error diagnostics and preserve the Marketplace `refreshFailure` after reloading the overview; partial failure returns false, writes the shared store error state, and shows message/failedAt on the Marketplace source row; batch refresh still shows sources that did update.
- The update entries of both the new and old UI stores follow the same partial-success semantics; legacy `usePlugins`, even if retired, must never report an error diagnostic as success.
- Source materialization errors strip URL username/password at the diagnostic generation boundary and clean URL userinfo from nested network causes; persistence, logs, protocol, and UI do not each handle secrets separately.
- New diagnostic codes: `plugin_git_unavailable`, `plugin_archive_fetch_failed`; other manifest/dependency errors keep their existing codes.

## Cross-platform and remote boundaries

- Source classification, download, extraction, Git fallback, and atomic activation all live in the zcode-cli adapter.
- Desktop/Web/mobile call only through the typed plugin service and the current workspace Agent Host.
- Remote workspaces keep selecting the authoritative Agent via `workspaceIdentity` / `remoteSessionId`; no separate runtime is created.
- Remote plugin source archive sync — uploading an already-materialized local directory to the remote — is a separate path this feature does not remove.
- Desktop `continuous` and mobile `replayable` session/task delivery are unchanged.

## Acceptance and test order

Failing tests are written first, then the implementation:

1. loopback GitHub Archive fixture with Git absent from PATH: Marketplace add/update and plugin install succeed;
2. `sha/commit > ref > HEAD` URL selection and plugin `path` / `git-subdir` resolution;
3. private-semantics fallback returns `plugin_git_unavailable` without Git;
4. Archive network failures do not mistakenly fall back to Git;
5. one Marketplace refresh failing while another succeeds, with the old snapshot and failure state preserved;
6. the next success clears the failure;
7. a public GitHub Marketplace declaring `sparsePaths` sends no Archive request and keeps the system Git sparse route;
8. a plugin subdirectory inheriting LFS rules from ancestor `.gitattributes` must fall back to Git;
9. simulated active-read, uncommitted-exit, and committed-exit windows read or recover state, Marketplace, and installed cache by authority transaction generation;
10. a partial Marketplace refresh failure still reloads successful sources while the store returns false and the page shows the persisted failure;
11. legacy and current UI stores both return false for error diagnostics;
12. Git sources with URL userinfo and nested Archive causes never leak username/password into failure diagnostics;
13. an injected failure during install copy/rename keeps the old cache and installed record;
14. explicit ZIP SHA-256, safety limits, and path protection regressions;
15. startup discovery still loads the installed cache with Git absent from PATH and the network down;
16. focused tests, `pnpm typecheck`, `pnpm lint`, then a real public GitHub smoke.

Corresponding lifecycle cases: `PLM-LC-011 no-git-github-archive`, `PLM-LC-012 isolated-refresh-atomic-cache`.
