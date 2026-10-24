# Todo 33: Personal Provider Config Independent File and Legacy Store Retirement

> Status: Completed
>
> Date: 2026-08-28
>
> Source: pre-launch Provider Refactor config storage review
>
> Related tasks: [`Todo 06`](./todo-06-config-storage-envelope-repository-privatization.md),
> [`Bugfix 05`](./bugfix-05-personal-config-worker-refresh.md)

## 1. Problem

Personal Provider Config defaulted to `config.json` in the Environment config directory, a filename also used by the
old ZCode/CLI comprehensive config, so the formal Personal file, the Legacy Importer input and other product configs
collided physically; the Repository introduced a `pre-provider-v1` backup and corruption-recovery override to rewrite
the old format in place on the same file. In addition, the retired-write `model-providers.json` was still a Desktop
Legacy Reader fallback input, and Remote Workspace could still transport a Coding Plan API key from that old Store.
Neither compatibility chain belongs to the launch target.

## 2. Final Decision

Personal Provider Config and Personal Model Config Rules are saved in `provider_config.json` under each Environment
config directory, using the Repository's private version envelope (`schemaVersion`, `providerOrder`, `providers`,
`modelConfigRules`). It is the sole formal Personal Provider/Model Config file. `model-selection.json`, ZCode
Built-in Active/LKG, Account Config and the `config.json` of MCP/Plugin/Hook stay independent.

Because the feature was unlaunched:

- the Provider v1 intermediate format once written to `config.json` on the development branch is not recognized or
  migrated;
- `model-providers.json` is not read;
- Coding Plan API keys are not migrated from the old Provider Store;
- no migration backup is generated;
- Legacy `config.json` is never deleted or rewritten; it is only a one-time read-only input for published old
  configs.

## 3. Migration and Process Responsibilities

### 3.1 Desktop / Web Host Environment

```text
Local Host Provider Runtime.start()
  -> lock provider_config.json
     ├─ exists     -> read formal file
     └─ not exists -> read-only old config.json -> convert to sparse Personal Overlay -> atomically write provider_config.json
  -> Host Registry ready
  -> allow dispatching Agent Runtime Env / starting Worker
```

Each Desktop window has one Local Host and multiple windows can share one Environment config directory, so the first
migration re-checks existence inside the target file lock (idempotent under concurrent Host initialization). Host
completes Provider Runtime initialization before dispatching the formal path to Agent.

### 3.2 Desktop Agent Worker

The Worker reads only `provider_config.json` via `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`, holds no Legacy Importer and
does not participate in migration; long-lived Workers keep Bugfix 05's content-revision polling for external writes.

### 3.3 Standalone CLI

Standalone Prompt CLI/TUI is its own Environment composition root. When `~/.zcode/v2/provider_config.json` is
missing, it reads only the existing CLI user `config.json` and runs the one-time import. The Protocol Worker path
reads only the formal file.

## 4. Repository Semantics

- Default target filename is `provider_config.json` (`PERSONAL_PROVIDER_CONFIG_FILE_NAME` shared by Host, Services
  and Standalone CLI); explicitly injected test/host paths stay supported.
- First read inside the target file lock completes "existence check -> Legacy import -> atomic write"; the Legacy
  importer is called only when the target is missing. An existing formal file is never treated as versionless input.
- The Legacy Reader treats the source as missing only on `ENOENT`; IO, JSON parse and schema validation failures
  throw to the Repository and never become an empty Provider list. A read failure uses the existing memory
  degradation and recovery callback and does not create `provider_config.json`; write commands hitting the same
  failure must fail, so a one-time migration error cannot solidify into an empty config. The next read can re-attempt
  import; no timeout compensation, second migration state or old file listening.
- Legacy read errors contain only the source path, failure stage, system error code or validation field path, never
  original JSON, credential values or original parse errors; they are logged by the host's existing
  `onPersonalConfigRecovery` and must not leak original text through `cause`.
- Legacy source files always stay unchanged; `backupPersonalProviderConfigBeforeMigration`, `backupFilePath` and all
  `.pre-provider-v1-*.bak` behavior are deleted. Future formal-file `schemaVersion` migration is a direct atomic
  write with no extra backup.
- A corrupt formal file must not be treated as Legacy input: the Repository keeps the original file, degrades to a
  memory-empty Personal Overlay and reports the error, never overwriting user files to guarantee readiness. An
  invalid formal file is kept as-is.
- This process's `update()` still publishes `updated` immediately; other processes only poll the content revision of
  `provider_config.json`. Later changes to old `config.json` or `model-providers.json` do not trigger Registry
  refresh.

## 5. Old Chain Cleanup

- `model-providers.json`: Desktop Legacy Reader file fallback, old Store multi-version parse and related logs
  removed; the remaining Legacy Reader (`legacyZCodeConfigProviderReader`) only reads published old ZCode
  `config.json` Providers; tests and auxiliary types covering only `model-providers.json` removed; residual disk
  files are not listened to, migrated or deleted.
- Account Coding Plan key: `legacyAccountProviderApiKeyLoader`, the Account Credential Store/Service `loadLegacy`
  parameter and Remote Workspace old Provider Store key reads are deleted. The current account key is read only from
  the account-scope Credential Store; when missing it is resolved through current OAuth/server and written to the
  formal credential store.

## 6. Path Coverage

Modified uniformly: Desktop Local Host default Personal Config path; the `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` Host
dispatches to local/remote Agent; Standalone CLI `~/.zcode/v2/provider_config.json`; Desktop E2E Provider Config
seed and fixtures; Provider Node, Services, CLI and Desktop path/migration tests. Other `config.json` files are not
batch-renamed and explicitly out of scope: `~/.zcode/cli/config.json`, workspace `.zcode/config.json`, MCP, Plugin,
Hook, Command and Skill config, `model-selection.json`, ZCode Built-in Active/LKG files.

## 7. Acceptance Scenarios

1. Desktop/Services default target is same-directory `provider_config.json`; Standalone CLI default is
   `~/.zcode/v2/provider_config.json`.
2. Target missing: one-time import from old `config.json`; old file bytes unchanged and no `.bak` generated.
3. Target exists: Legacy Importer is not called.
4. `model-providers.json` is not read even if it exists.
5. Two Runtimes starting concurrently produce one complete formal file.
6. Host completes Personal initialization before dispatching Agent Runtime Env.
7. Two Repositories on the new file: formal atomic write still refreshes observers within one polling cycle.
8. Old file changes do not trigger a Personal change.
9. Account Credential Store/Service with a missing current key no longer reads the old Provider Store.
10. Desktop Provider Settings save, restart and connection testing use the same new file.
11. macOS, Windows and Linux paths are composed via Node `path`.

## 8. Completion and Outcome

No production default path uses Personal Provider `config.json`; production code no longer reads
`model-providers.json`; no old Coding Plan Provider key Loader or `loadLegacy` credential parameters; no Personal
Provider Config migration backups; Host/Worker/Standalone use the same `provider_config.json` per Environment;
Personal content-revision polling, connection-test active refresh and Active Model freeze are unchanged.
Verification: migration, path, concurrency, bad file, structure gate, Credential and CLI/Bootstrap directed tests;
root `pnpm typecheck`, `pnpm lint` and full `pnpm test:unit` passed (1487 files passed, 1 skipped, 12675 tests passed,
25 skipped).
