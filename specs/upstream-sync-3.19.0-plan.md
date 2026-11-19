# Upstream sync 3.19.0 — pre-merge plan

Status: analysis only (2026-11-19). Nothing ported.

Upstream released the 3.19.0 desktop app (build commit `a7ed1054`, built 2026-11-19T02:52Z) but has
**not** published its source: `zai-org/ZCode` `main` and the newest tag are still `fec975905` (v3.18.2),
which is our pin in `fork-upstream-base.json`. For 3.18.2 the source landed about 4 days after the build.

This document is the diff between the 3.18.2 and 3.19.0 macOS arm64 builds (both `app.asar` and the bundled
`glm/` CLI), grouped by feature, with the fork files each feature will conflict on. It is the checklist for
the real `git merge` once upstream pushes the 3.19.0 source; it is not a port spec.

**Recommendation: wait for the source and merge it** (the 3.18.1/3.18.2 lesson: binary reconstructions get
reverted or superseded once the source lands, see `specs/upstream-sync-3.18.2.md`). Nothing below is urgent
enough to reconstruct now (see "Impact today").

## Method

- Builds: 3.18.2 from `cdn-zcode.z.ai/zcode/electron/releases/3.18.2/macos-arm64/ZCode-3.18.2-mac-arm64.zip`;
  3.19.0 = the installed `/Applications/ZCode.app` (`build-meta.json`: appVersion and minCompatibleVersion 3.19.0).
- Bundles (main, host, preload, scheduler, extension-host, renderer, CLI `zcode.cjs`): unique string literals via
  the acorn tokenizer, then prettier plus short-identifier normalization and function-level diffs for logic.
  Renderer features were indexed by the English message map (7801 → 7861 keys: +104, −44, 4 changed).
- Bundled plugins (`glm/packages/*`): exact file diff against `apps/zcode-cli/packages/*` at `fec975905`.
- "confirmed" = seen in code or key diffs; "inferred" = from strings only. Upstream file paths are where the
  old literals live at `fec975905`; NEW modules have no path yet.

## Impact today (3.19.0 is installed on this Mac and shares `~/.zcode` with fork builds)

| Area                                      | Finding                                                                                                                                                                                                                                                        | Effect on fork builds now                                                                                                                                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI DB `~/.zcode/cli/db/db.sqlite`        | 3.19.0 applied `0026_dwf_run_parent_session_index` (`create index if not exists dwf_run_parent_session_idx on dwf_run(parent_session_id);`, appVersion 0.17.3). Ledger checksum `6d69a28d…` = sha256 of that exact SQL (verified).                             | None. Node (`migration-runner`) and zcode-rs (`node-store/src/repo/open.rs` `preflight`) only check known ids; the extra index is harmless.                                                                   |
| Tasks DB `~/.zcode/v2/tasks-index.sqlite` | No new migration (18 identical upstream ids; `tasksStorageWorker.js` logic identical).                                                                                                                                                                         | None.                                                                                                                                                                                                         |
| `setting.json`                            | New upstream keys `replyLanguage` (string 1–256 / null), `preinstalledToolsAutoInstall` (bool, default true), `preinstalledToolsAgentDisabled` (string[]).                                                                                                     | A fork build strips unknown keys on its next settings write, so these 3.19.0 settings reset to defaults after running the fork. Cosmetic; fixed by the merge (they are upstream schema keys, not fork state). |
| Credentials                               | Cipher format unchanged (`enc:v2:os:`, `enc:v2:env:`, legacy `enc:v1:`). New sidecars only on the recovery path: `credentials.json.recovery-generation`, `*.key-unavailable-<id>.bak`, `credential-secret.invalid-<id>.bak`; new env `ZCODE_CREDENTIALS_FILE`. | Readable both ways. Risk only if 3.19.0 runs its key-unavailable reset: it backs up and empties `credentials.json` for both builds.                                                                           |
| New files under `~/.zcode`                | `v2/workspace-plugin-trust-v1.json` (plugin trust), `<dataRoot>/preinstalled-tools/<release>/{bin,tools,versions,staging}`, CLI reads optional `cli/browser-state.json`.                                                                                       | Ignored by the fork.                                                                                                                                                                                          |

## Features (by merge risk)

Fork divergence = commits on `fec975905..HEAD` touching the file.

### A. Preinstalled document tools — NEW, large

- Help → "Preinstalled tools" dialog. A utility process (`out/preinstalled-tools/process.js`, service
  `zcode-preinstalled-tools`) downloads, sha256-verifies, extracts, rewrites placeholders, ad-hoc codesigns
  (darwin) and runtime-checks Python 3.12.16, LibreOffice 26.8.1, Poppler 26.10.0, qpdf 12.4.2 and Pandoc into
  `<dataRoot>/preinstalled-tools`. It writes bin shims (`zcode-python`, `zcode-soffice`, `pdftotext`, `qpdf`, `pandoc`, …).
  CDN `https://cdn-zcode.z.ai/zcode/preinstalled-tools` (env override `ZCODE_PREINSTALLED_TOOLS_CDN_BASE_URL`).
  IPC `zcode:preinstalled-tools:{command,get-state,state}` (main window only); commands set-auto-install,
  set-agent-enabled, sync-entries, prepare, cancel, delete (delete blocked while in use). The Agent child gets
  `ZCODE_PREINSTALLED_TOOLS_AVAILABLE=1` and the bin dir first on PATH (Git Bash too: `withPreinstalledBinFirst`).
  Storage category `preinstalledTools` in the resource manager. Confirmed.
- Companion plugin changes: documents/pdf/presentations/spreadsheets plugins gain `scripts/zcode_libreoffice.py`,
  a LibreOffice profile and `env_setup/libreoffice-unmanaged.md`; the official asset manifest lists them.
- Files: all NEW, plus `packages/desktop/src/host/index.ts` (5 fork commits), `preload/index.ts` (6), the settings
  schema, `apps/zcode-cli/packages/adapters/src/exec/bash-shell-provider.ts` / `bash-startup-script.ts` (1),
  `electron-builder.config.js` (packaging).
- Fork work: the release CI must package the new utility process; the fork's own `fork-test-files` none.
  zcode-rs: Agent PATH parity (`ZCODE_PREINSTALLED_TOOLS_AVAILABLE`, bin dir first) — **parity task**.

### B. Workspace plugin trust and hook-script pinning — NEW, high

- Project-config plugins start "pending" until trusted per (workspaceIdentity, pluginRoot, declarationDigest).
  RPC `plugins/workspaceTrust` (client→CLI) `{workspace, pluginRoot, declarationDigest /^[a-f0-9]{64}$/, trusted}`
  → `{accepted, reasonCode?: workspace_plugin_declaration_changed | workspace_plugin_trust_unavailable}`.
  Store `workspace-plugin-trust-v1.json` (`schemaVersion:1`, records with `grantedAt`), atomic write under lock.
  UI: `settings.plugins.workspaceTrust.*`, "Pending trust", "disabled in this project". Confirmed.
- Hook scripts: each hook that runs a script file (direct path or python/python3/perl/ruby interpreter,
  `CLAUDE_PROJECT_DIR`/`ZCODE_PROJECT_DIR`) gets a sha256 in the declaration digest. It is re-hashed before
  every dispatch, fails closed (`workspace_hook_declaration_changed`, new `workspace_hook_script_unavailable`,
  `hook.verify.failed_closed`). Confirmed.
- Files: `packages/shared/src/zcode-protocol/index.ts` (7 fork commits), `apps/zcode-cli/packages/adapters/src/plugins/index.ts` (2),
  `bootstrap/src/plugins.ts` (2), `bootstrap/src/zcode-protocol/server-operations.ts` (4),
  `bootstrap/src/app/workspace-hook-review-controller.ts` (2), `core/src/hooks/*`, `adapters/src/storage/workspace-hook-trust-store.ts`,
  `packages/services/src/zcode-agent/zcodeAgentService.ts` (11), `packages/ui/src/settings/PluginStoreCard.tsx` (2),
  `PluginStoreDetailView.tsx`, `McpServerList.tsx` (3).
- Overlaps fork work: the fork's own workspace plugins/MCP/hook trust (#462/#467/#468, Rust `app_workspace.rs`,
  `config/mcp_trust.rs`, `commands/hooks_trust.rs`). Resolve against the fork's trust owner, do not add a second store.
  zcode-rs: plugin trust and script pinning missing — **parity task**.

### C. Agent reply language — NEW, medium

- Settings → Behavior and tools → "Reply language" (local desktop only). IPC `zcode:set-reply-language` →
  `applyReplyLanguage` persists `setting.json` `replyLanguage`, posts `ReplyLanguageChanged` to children; host
  answers CLI→client RPC `session/readReplyLanguage` `{sessionId}` → `{language}` (−32602 on bad params). The CLI
  injects a `# Language` system reminder ("Always respond in X …") when it changes, "The language preference was
  cleared…" on clear, restated after compaction. Confirmed.
- Files: `packages/desktop/src/main/index.ts` (7), `preload/index.ts` (6), `host/index.ts` (5), `packages/shared/src/channels.ts` (8),
  `validation.ts` (5), protocol `index.ts` (7), `apps/zcode-cli/packages/core/src/runtime/methods/context-refresh.ts` (3),
  `core/src/system-reminder/source.ts` (3), settings schema.
- zcode-rs: missing (`session/readReplyLanguage`, reminder injection) — **parity task**.

### D. Status panel → composer status capsule — UI, high conflict

- The right-side Status panel is removed: `chat.summaryPanel.*` display modes, `chat.statusPanel.*` sections and
  the composer "background works" tooltip, 44 keys in all. It is replaced by a composer capsule (`chat.capsule.*`: todo,
  activity, goal and files states) with a status popover (git rows, "View all changes") and subagent/workflow
  activity directories; "Elapsed {duration}" on the chat target. Snapshot schema adds `activitySummaryDismissed`,
  `completedActivityCount`, `backgroundWorks[].resultSummary` (≤4096), `hasCompactWork`; the CLI adds
  `dwf getActivityHistory(parentSessionId)` for v4 hydrate (uses migration 0026). Keys confirmed; behaviour inferred.
- Files: `packages/ui/src/v4/ConversationStatusPanel.tsx` (2 fork commits, +482/−126), `packages/ui/src/v4/SessionPane.tsx`
  (6, +1386/−133), `packages/shared/src/zcode-protocol-v4/transport.ts` (3), `zcodeTaskIndexSyncer.ts` (5),
  `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/dwf-journal.ts` (1, +90/−69).
- Decision needed at merge: what the fork's Status-panel additions become in the capsule (product decision, align
  visually first). E2E scenarios touching the status panel must be rewritten.
- zcode-rs: snapshot fields and activity history — **parity task**.

### E. Credential store recovery — changed, high (shared data)

- Private-file key fallback is no longer Linux-only (any OS when the system keychain fails). Key failures are
  observed (`notifyKeyFailure`) and can trigger a backup-and-reset of `credentials.json`: verified backup to
  `.key-unavailable-<id>.bak`, write `.recovery-generation`, reset to `{}`, drop the `credential-source` pin; managed
  stage moves a bad `credential-secret` to `.invalid-<id>.bak`. There is also an owner-file lock with abandoned-lock reclaim, a generation guard
  (`withCredentialGeneration`, `ZCODE_CREDENTIAL_STORE_CHANGED`), and the env `ZCODE_CREDENTIALS_FILE` (absolute path;
  precedence: explicit filePath → env → `<base>/.zcode/v2/credentials.json`). `getCredentialsDir` removed. Confirmed.
- Files: `packages/shared/src/credential-security/systemCredentialCipher.ts` (0 fork commits in file; fork tests exist),
  `packages/shared/src/node/privateFilePersistence.ts` (2), `packages/services/src/credential/credentialService.ts` (2),
  `apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts` (2; fork adds `ZCODE_DATA_BASE_DIR` handling).
- Re-run fork tests `systemCredentialCipher.test.ts`, `accountProviderStartPlan.test.ts` after the merge.
- zcode-rs: `crates/platform/src/{credentials,system_cipher}.rs` has `enc:v2` but no `ZCODE_CREDENTIALS_FILE`, generation
  guard or recovery — **parity task, shared-data critical** (Rust writing during a Node reset must not lose data).

### F. MCP lifecycle rework (CLI) — high

- Built-in stdio servers auto-restart (5 per 10 min, then failed: `mcp.server.restart.limit_reached`). Other stdio
  servers fail with `ConnectionClosed` / `unexpected_disconnect`. HTTP/SSE reconnect, and `session_expired` invalidates the connection.
  Tool catalog becomes snapshot-based; subagents take the parent's startup snapshot. Reconnect/pool/replay telemetry removed
  ("MCP resource subscriptions replayed after reconnect" is gone). `WaitForMcpServers` result adds `needsAuth` and
  splits `disabled`/`unknown`. Deferred-tool reconciliation reminders ("…their source has since been removed").
  Restart and session paths confirmed; snapshot design inferred.
- Files: `apps/zcode-cli/packages/adapters/src/mcp/index.ts` (5 fork commits, +270/−218), `adapters/src/plugins/mcp.ts`,
  `mcp-official-auth.ts`, `bootstrap/src/zcode-protocol/mcp.ts`.
- Overlaps fork MCP work (Rust-run MCP F7 PRs #566/#568, MCP OAuth). zcode-rs: `crates/ext/src/mcp/wait_tool.rs`
  lacks `needsAuth` (its own comment says the state model has none); no restart limit — **parity task**.

### G. Conversation share artifact import hardening — medium/high

- Import allow-list by artifact type + extension + MIME, magic-byte sniffing (`%PDF-`, ZIP/OOXML, PNG/JPEG/WEBP,
  UTF-8 text), sanitized unique names, quarantine marking (macOS `com.apple.quarantine` xattr, Windows
  `Zone.Identifier` ZoneId=3). New error codes `artifact_{corrupted,dimensions_exceeded,encoding_invalid,
format_mismatch,safety_rejected,type_rejected,upload_missing,upload_rejected}`, `content_blocks_limit`,
  `conversation_safety_rejected`, `preparation_stale`; 13 per-issue UI messages and a rate-limit wait. Confirmed.
- Files: `packages/services/src/conversation-share/conversationShareService.ts` (3, 174/145),
  `conversationShareArtifactDiscovery.ts` (2), `conversationShareArtifactSource.ts` (1), `packages/ui/src/lib/conversationShareError.ts` (2),
  `ConversationShareConfirmationDock.tsx` (1).

### H. Telemetry and diagnostics — medium

- `v4/telemetry/turn-admission` notification (`isFirstMessage`, `sendMode` direct|queued); prompt telemetry gains
  `is_first_message`, `send_mode`, `ttft_*`. `plugin.discovery` facts (agent plugin recommendation card: `card_shown`,
  `card_resolved`, `install_settled`, `agent_search`, `recommend_*`). `workflow_run_result` event. Tool `error_code`
  enum (~45 codes). Agent crash classifier: native OOM exit `0xE0000008`, stderr tail (20 lines), redaction, 16-hex
  crash fingerprint. Diagnostic log archive keeps complete tail records of oversized logs (new skip reasons,
  UTF-16 aware). CLI memory diagnostics `heap-pressure` and related degradation reasons. Compact output-limit warning.
- Files: `packages/shared/src/zcode-protocol-v4/{transport,telemetry}.ts` (3/3), `conversation-telemetry/*`,
  `zcodeAgentService.ts` (11), `zcodeAgentProcessManager.ts` (5, +227/−145), `packages/shared/src/agent-crash-diagnostic/*` (1),
  `packages/services/src/feedback/feedbackLogArchive.ts` (4), `packages/desktop/src/main/exportLogs.ts` (4),
  `packages/shared/src/memoryDiagnostics.ts` (4), `apps/zcode-cli/.../conversation-telemetry-facts.ts` (2),
  `core/src/runtime/methods/compact-active.ts` (4).
- zcode-rs: `crates/protocol-zcode/src/telemetry.rs` has model-request-metrics only — turn-admission and plugin.discovery
  missing (**parity task**, low priority).

### I. Git invocation hardening — high conflict, small behaviour

- All product git calls go through `buildProductGitArgs`: `-c core.fsmonitor=`; diff/show/log also get
  `--no-ext-diff --no-textconv`. Per-call prefixes removed. Confirmed.
- Files: `packages/services/src/git/repo/gitCliRepo.ts` (2 fork commits, +818/−50), `git/gitService.ts` (1),
  `git/repo/gitCheckpointRepo.ts` (1). zcode-rs: check `--no-textconv` on diff calls.

### J. Bash tool hardening (CLI) — medium

- Direct `adb` is blocked (use the `android_*` MCP tools). Windows cmd dialect read-only allowlist (`dir`, `type`, `findstr`,
  `where`, read-only `git`) with safe external-lookup checks. Dangerous-option checks for tar, unzip, zipinfo, xxd, findstr, where.
  More read-only git flags and `git ls-tree`. Confirmed.
- Files: `apps/zcode-cli/packages/adapters/src/exec/bash-shell-provider.ts` (1) and the classifier (not located).
  zcode-rs `crates/policy/src/shell/*`: missing — **parity task**.

### K. Main-process safety features — medium

- Executable file open confirmation ("Opening this file may run commands", per-OS extension lists, script-runner apps).
- `will-navigate` guard blocks top-level navigation of app windows to non-app URLs.
- Linux package update authorization (`sudo -n -v`, Continue/Later before `quitAndInstall`).
- Crash recovery dialog on `render-process-gone` plus `RestartAfterCrash` command; the renderer ErrorBoundary gets "Restart app".
- Plugin sandbox initial theme injection; browser local preview file identity checks (dev/ino, reject nlink>1).
- Host proxy helpers (`createHostApiNetworkTransport`, `resolveHostProxyForUrl`) also used in main.
- Files: `packages/desktop/src/main/index.ts` (7), `autoUpdater.ts` (4), `desktopCrashCapture.ts`, `desktopCommandHandlers.ts`,
  `pluginSandbox/*`, `browser-local-preview/*`, `desktopNetworkPolicy.ts`, `packages/ui/src/ErrorBoundary.tsx` (2).

### L. Smaller items

- Public client config: `draftModelMigration` (server rule moves drafts from source models to a target model on
  official providers, one-time per revision, localStorage marker `zcode-draft-model-migration:v1:`) and
  `clientConfigRefreshIntervalSeconds` (60–3600 s, default 3600; cached snapshot kept on failure). Files
  `packages/shared/src/clientConfig.ts` (1), `clientConfigService.ts` (2), `composerRecent.ts` (2). Overlaps the fork's
  draft-model-switch E2E.
- Builtin provider ids `bigmodel-standard-api`, `zai-standard-api`. Builtin release download reuses an unchanged
  URL (`releaseUrl`, `releaseDownloadedAt`; `packages/provider-node/src/zcode-builtin-download.ts`, 3).
- Project display order pushed window→host (`setProjectDisplayOrder`, max 5000). Upstream path
  `packages/desktop/src/host/windowHostControllerService.ts` was moved by the fork to `packages/services/src/window-controller/`, so this is a manual port.
- Active session count reporting (`reportActiveSessionCount`; `zcodeTaskIndexSyncer.ts`, 5 fork commits, +601/−331).
- CLI: headless `--browser-state <path>` / `--no-browser-state` (default `~/.zcode/cli/browser-state.json`, Playwright
  storage state). Files `apps/zcode-cli/packages/cli/src/{arguments,run,headless-browser}.ts` (0 fork commits, clean).
- CLI subagents: foreground subagent moves to background on user input; SendMessage cold restore; refuses resume while
  stopping (`core/src/subagent/runner.ts`, 3).
- Skill listing as deltas from a shared catalog (inferred).
- **Voice shortcut collision:** upstream adds `toggleVoiceInput` (`CmdOrCtrl+Shift+D`). The fork already has
  `voiceDictation` with the same default (`packages/shared/src/shortcutCommands.ts:108`). Keep one id and migrate saved bindings.
- UI copy: fork-session failure hides the error detail; rewind guard reasons (unsafe, ignored files, unavailable,
  apply conflict); goal Pause/Resume shortened; "Plan mode" slash label; model picker search/guide; separate PPTX preview chunk.
- Some Chinese strings became English (browser command timeout, REPL messages).

### M. Bundled plugins (exact diff against `apps/zcode-cli/packages/*`)

- 85 changed files equal upstream 3.18.2 source and are untouched by the fork: take them verbatim.
- 5 files touched by the fork (version/dependency bumps only): `android-emulator-plugin/{README.md,package.json}`,
  `browser-use-plugin/package.json`, `ios-simulator-plugin/README.md`, `zcode-cua-plugin/package.json`: 3-way merge.
- New: design-plugin `references/{app,deck,image,motion,page}.md`, `scripts/{audit-page.js,audit.mjs,probe.js}`
  (`references/output.md` removed); LibreOffice scripts/profile in the 4 office plugins; `presentations-plugin/skills/pptx/env_setup`;
  site-deploy scripts moved from `zcode-site-plugin/scripts/` into `skills/site-deploy/scripts/`.
- Built `dist/` changes: office plugin servers are version bumps only; ios-simulator scheme discovery (`xcschemes`,
  `-list -json`); `node-repl-host` gains a large Computer Use client (~1000 new strings: permission guidance,
  ownership checks, `select_text`/`set_value` refusals). Its source is in `apps/zcode-cli/packages/node-repl-host/src`
  and arrives with the merge.
- Versions: design 0.7.2→0.8.0, android 0.1.1→0.1.2, browser-use 0.5.1→0.5.2, cua 0.6.5→0.6.6, office plugins 0.2.2→0.2.9 (pdf 0.2.10).

#### M.1 Pre-port applied ahead of the source (2026-11-19, user request)

Applied from `upstream-diff-3.19.0/plugins/bundled-plugins.patch` (build `a7ed1054`); target versions and seed paths
taken from the 3.19.0 CLI bundle, not inferred from the patch:

- Taken: documents, pdf, presentations, spreadsheets (LibreOffice wrapper + profile; preinstalled-tools guidance only
  activates when `ZCODE_PREINSTALLED_TOOLS_AVAILABLE` is set, which fork builds never set, so the existing install
  guidance stays in effect), android-emulator (skill names only tools the fork's server already has), browser-use,
  zcode-site (scripts move to `skills/site-deploy/scripts/`, error wording).
- Held back: **design 0.8.0** (restructured references; the fork's design tests check the 0.7.2 layout and the
  rewritten upstream tests are not in the build), **ios-simulator README** (describes scheme resolution of a built
  server we do not have and links to a missing doc), **zcode-cua 0.6.6** (the client now copies the compact
  metadata into `content`; upstream paired it with a core change that adds `Structured content:` only when `content`
  is empty, while fork core still adds it whenever it is non-empty, so the model would get the metadata twice; fork
  tests rely on the structured error channel, so core cannot be changed alone). All built `dist/` changes, including
  `node-repl-host`.
- Fork-side follow-through: versions synced in `bootstrap/src/app/official-plugin-definitions.ts` and
  `cli/scripts/sea-official-plugin-assets.mjs` (an unbumped seed version keeps loading the old cache); zcode-site
  `requiredSeedPaths`, `build-sea.test.mjs` seeds and version assertion, site test imports and wording,
  `.staged-file-size-exemptions` path. `scripts/architecture/upstream-snapshot.json` stays as is (pins upstream).
- Fork fixes in the four identical `scripts/zcode_libreoffice.py` copies (review of PR #577): profile/conversion
  directory cleanup failures only warn, so they no longer replace a successful result or re-run a completed operation
  through system LibreOffice; a cancel while the managed process fails to start stays a cancel instead of starting the
  system fallback. Re-apply both on the source merge if upstream has not fixed them.
- When the source arrives: take upstream's versions of these files; port design 0.8.0 with its tests.

## Merge checklist (when upstream pushes the 3.19.0 source)

1. `git fetch upstream`; branch `sync/upstream-3.19.0` from `fork`; `git merge --no-ff <3.19.0 commit>`.
   **Merge the PR with "Create a merge commit"** (temporarily enable `allow_merge_commit`, see `specs/upstream-sync-3.18.1.md`).
2. Resolve conflicts in this order: protocol (`zcode-protocol/index.ts`, `zcode-protocol-v4/transport.ts`) → services
   (`zcodeAgentService.ts`, `gitCliRepo.ts`, `conversationShareService.ts`, `zcodeTaskIndexSyncer.ts`) → CLI
   (`adapters/src/mcp/index.ts`, plugins, hooks) → desktop main/host/preload → UI (`SessionPane.tsx`, status panel, `en-US.ts` by key).
   Use real `git merge-file` 3-way merges, never "take theirs" for fork-modified files.
3. Verify the 0026 checksum after the merge: `sha256(sql.trim())` must equal `6d69a28db682619252975fb1113fefb22a5499efefe1249da4b04190830ff48d`
   (already in the live ledger). Then `pnpm db:migrations:baseline:update`, `pnpm db:migrations:check`.
4. Bump `fork-upstream-base.json`; regenerate `fork-upstream-migrations.json`, `node scripts/licenses.mjs notices`,
   Rust `inbound.json` (`pnpm exec tsx scripts/fork-rust-agent/inbound-schema.mts`) and check the bundled
   `crates/platform/assets/zcode-builtin.json` against `config/provider/zcode-builtin.json`.
5. Known traps: staged-size gate (`.staged-file-size-exemptions`), `test-copy:check` zh suites (`localeAllowlist`),
   `fmt:check` mid-merge (oxfmt on `git diff --cached --name-only <pin>`), CLI typecheck via turbo, missing mocks for
   new upstream hooks in fork tests.
6. Product decisions to take with the owner before resolving: D (status panel → capsule vs fork additions),
   B (one trust owner for plugins/hooks/MCP with the fork's trust work), the voice shortcut id.
7. `pnpm typecheck`, `pnpm lint`, `pnpm test:engineering:affected --scope worktree`, fork tests, desktop E2E
   (status panel, plugin trust, conversation share, draft-model-switch).

## zcode-rs parity backlog after the merge

Highest first:

1. Credential recovery and `ZCODE_CREDENTIALS_FILE` (E).
2. Migration 0026 in `node-store` `MIGRATIONS`, plus `getActivityHistory` (D).
3. Reply language (C).
4. Workspace plugin trust and hook-script pinning (B).
5. MCP restart limit and `needsAuth` (F).
6. Preinstalled tools PATH (A).
7. Bash/adb/cmd rules (J).
8. Turn-admission and plugin.discovery telemetry (H).
9. Compact output-limit warning.
10. Browser state.

## Not explained

`MonitorActivity` surface; agent recommendation card behaviour; input-preemption trigger; MCP snapshot wiring;
`runningTaskCount` composition; persistence of project display order.
