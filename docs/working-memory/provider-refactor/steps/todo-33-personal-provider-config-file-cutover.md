# Todo 33: Personal Provider Config Independent File and Legacy Store Retirement

> Status: Completed
>
> Date: 2026-08-28
>
> Source: Pre-launch Provider Refactor config storage review
>
> Related tasks: [`Todo 06`](./todo-06-config-storage-envelope-repository-privatization.md),
> [`Bugfix 05`](./bugfix-05-personal-config-worker-refresh.md)

## 1. Problem

Current Personal Provider Config defaults to `config.json` in Environment config directory. That filename simultaneously used by old ZCode/CLI
comprehensive config, causing formal Personal file, Legacy Importer input, and other product configs to physically conflict in naming. Repository introduced `pre-provider-v1` backup and corruption recovery override to in-place rewrite old format on same file.

Additionally, retired-write `model-providers.json` still used by Desktop Legacy Reader as fallback input; Remote Workspace may still transport Coding Plan API Key from that
old Store. These two compatibility chains no longer belong to launch target.

## 2. Final Decision

Personal Provider Config and Personal Model Config Rules uniformly saved in:

```text
provider_config.json
```

under each Environment config directory.

File content continues using Repository private version envelope:

```text
schemaVersion
providerOrder
providers
modelConfigRules
```

`provider_config.json` is the sole formal Personal Provider/Model Config file. `model-selection.json`, ZCode Built-in
Active/LKG, Account Config, MCP/Plugin/Hook used other `config.json` all remain independent.

This feature not yet launched, therefore:

- Do not recognize or migrate Provider v1 intermediate format once written to `config.json` on current development branch;
- Do not read `model-providers.json`;
- Do not migrate Coding Plan API Key from old Provider Store;
- Do not generate migration backup;
- Do not delete or rewrite Legacy `config.json`, it only serves as one-time read-only input for published old configs.

## 3. Migration and Process Responsibilities

### 3.1 Desktop / Web Host Environment

```text
Local Host Provider Runtime.start()
        |
        v
Lock provider_config.json
        |
        +-- exists --> read formal file
        `-- not exists --> read-only old config.json
                         |
                         v
                    Convert to sparse Personal Overlay
                         |
                         v
                    Atomically write provider_config.json
        |
        v
Host Registry ready
        |
        v
Allow dispatching Agent Runtime Env / starting Worker
```

Desktop each window has one Local Host; multiple windows can share same Environment config directory. First migration must re-check
existence within target file lock, making concurrent initialization of multiple Hosts idempotent. Host must complete Provider Runtime initialization before dispatching formal path to Agent.

### 3.2 Desktop Agent Worker

Desktop dispatched Agent Worker only reads `provider_config.json` via `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`. It does not hold
Legacy Importer, does not participate in migration; long-lived continues using Bugfix 05's content-revision polling tracking external writes.

### 3.3 Standalone CLI

Standalone Prompt CLI/TUI is its own Environment composition root. When `~/.zcode/v2/provider_config.json` missing, reads existing
CLI user `config.json` only and executes one-time import. Protocol Worker path still reads only formal file.

## 4. Repository Semantics

- Default target filename unified to `provider_config.json`; explicitly injected test/host paths continue supported;
- First read within target file lock completes "existence check -> Legacy import -> atomic write";
- Legacy Reader only considers source file missing when read returns `ENOENT`; IO, JSON parse, schema validation failures must throw error to
  Repository, cannot convert to empty Provider list. Read failure uses existing memory degradation and recovery callback,
  does not create `provider_config.json`; write commands encountering same failure must fail, preventing one-time migration error from permanently solidifying to empty config.
  Next read can re-attempt import; no timeout compensation, second migration state, or old file listening.
- Legacy read errors only contain source path, failure stage, system error code, or validation field path, not original JSON, credential values, or
  original parse errors. Logged by host existing `onPersonalConfigRecovery`; error content must not leak original text through cause.
  This boundary also applies to Desktop / Web Host, Worker, and phone real-time message delivery semantics unchanged.
- Legacy source files always remain unchanged, therefore deleting `backupPersonalProviderConfigBeforeMigration`, `backupFilePath`, and all
  `.pre-provider-v1-*.bak` behavior;
- Formal file future `schemaVersion` migration directly submitted via atomic write, no extra backup creation;
- Formal file corruption must not disguise as Legacy input. Repository keeps original file, degrades to memory empty Personal Overlay and reports error, does not overwrite user files to guarantee ready;
- Repository this process `update()` still immediately publishes `updated`; other processes only poll `provider_config.json` content revision;
- Old `config.json` or `model-providers.json` subsequent changes do not trigger Registry refresh.

## 5. Old Chain Cleanup

### 5.1 `model-providers.json`

- Delete Desktop Legacy Reader file fallback, old Store multi-version parse, and related logs;
- Remaining Legacy Reader only expresses "read old ZCode `config.json` Providers," renamed by responsibility;
- Delete tests and auxiliary types covering only `model-providers.json`;
- Do not listen, migrate, or delete potentially residual files on disk.

### 5.2 Account Coding Plan Key

- Delete `legacyAccountProviderApiKeyLoader`;
- Delete Account Credential Store/Service's `loadLegacy` parameter;
- Delete Remote Workspace old Provider Store Key reads;
- Current account Key only read from account-scope Credential Store, missing then parsed through current OAuth/server and written to formal credential store.

## 6. Path Coverage

Must uniformly modify:

- Desktop Local Host default Personal Config path;
- Host dispatched to local/remote Agent's `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`;
- Standalone CLI's `~/.zcode/v2/provider_config.json`;
- Desktop E2E's Provider Config seed;
- Provider Node, Services, CLI, Desktop path and migration tests.

Must not batch-rename other `config.json`. The following files explicitly not part of this Todo:

- `~/.zcode/cli/config.json`;
- workspace `.zcode/config.json`;
- MCP, Plugin, Hook, Command, Skill config;
- `model-selection.json`;
- ZCode Built-in Active/LKG files.

## 7. Test Plan

Write failing tests first, then modify production implementation:

1. Desktop/Services default target same-directory `provider_config.json`;
2. Standalone CLI default target `~/.zcode/v2/provider_config.json`;
3. Target missing: one-time import from old `config.json`, old file bytes unchanged and no `.bak` generated;
4. Target exists: do not call Legacy Importer;
5. `model-providers.json` even if exists not read;
6. Two Runtime concurrent first start produces only one complete formal file;
7. Host completes Personal initialization before dispatching Agent Runtime Env;
8. Two Repositories pointing to new file: formal atomic write still refreshes observers within one polling cycle;
9. Old file changes do not trigger Personal change;
10. Account Credential Store/Service missing current Key no longer reads old Provider Store;
11. Desktop Provider Settings save, restart, and connection testing continue using same new file;
12. macOS, Windows, Linux paths all composed via Node `path`, not relying on separators.

## 8. Completion Criteria

- No Personal Provider `config.json` in production default paths;
- Production code no longer reads `model-providers.json`;
- Production code has no old Coding Plan Provider Key Loader or `loadLegacy` credential parameters;
- No Personal Provider Config migration backups created;
- Host/Worker/Standalone use same `provider_config.json` for same Environment;
- Personal content-revision polling, connection testing active refresh, and Active Model freeze semantics unchanged;
- Directed tests, related E2E, `pnpm typecheck`, `pnpm lint`, and modified file format checks pass.

## 9. Implementation Results

- `PERSONAL_PROVIDER_CONFIG_FILE_NAME` becomes formal filename fact shared by Host, Services, and Standalone CLI; Desktop
  E2E seed and fixtures synchronized to `provider_config.json`;
- Repository's Legacy importer called only when target missing, import and atomic creation completed within target file lock; existing formal file
  no longer treated as versionless input, no `.bak` generated or recovered; invalid formal files kept as-is and degraded to memory empty Overlay;
- Local Host waits for Provider Runtime initialization before dispatching Agent Runtime Env, Workers only receive formal file path and continue using
  content-revision polling;
- Old Reader renamed to `legacyZCodeConfigProviderReader` by remaining responsibility, reads only published old `config.json`; production source code
  `model-providers.json` references zeroed;
- `legacyAccountProviderApiKeyLoader`, Credential Store/Service's `loadLegacy` parameter, and Remote Workspace old Key
  transport all deleted;
- Migration, path, concurrency, bad file, structure gate, Credential, and CLI/Bootstrap directed tests passed; root `pnpm typecheck`,
  `pnpm lint`, and full `pnpm test:unit` passed. Full results: 1487 files passed, 1 skipped, 12675 tests passed,
  25 skipped.
