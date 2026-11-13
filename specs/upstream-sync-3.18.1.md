# Upstream sync 3.18.1

Status: merged on branch `sync/upstream-3.18.1` (2026-11-13), PR open.

Upstream `c5904686e` ("chore: sync ZCode source v3.18.1") is merged into `fork` with a real
`git merge --no-ff`. The previous pin is `b95ebaffe` (v3.18.0), which is the merge-base. The upstream
commit touches 111 files (+3906/-528): 19 added, 1 deleted, 91 modified.

**The PR must be merged with "Create a merge commit".** A squash drops `c5904686e` from the fork's
ancestry and `pnpm fmt:check` then fails (`specs/fork-format-scope.md`); see #380/#381 and #412.

## Replacing the reconstructed backport

`specs/upstream-backport-3.18.1.md` reconstructed 3.18.1 from the shipped binary because the source
was not public. Its rule for this sync is to take upstream's files and drop the reconstruction, not to
merge hunk by hunk. The branch therefore has two steps:

1. `revert: drop the 3.18.1 backport reconstructed from the binary`: reverse-applies the backport
   commits (`9c879d0cd..309eaabf3` on the #402 head) onto `fork`. Fork commits made after the backport
   stay. Two hunks conflicted with later fork work and keep the fork side:
   - `packages/ui/src/v4/ConversationComposer.tsx`: owner decision 5 of
     `specs/upstream-sync-3.18.0.md` (#414) removed the upstream voice input button, so there is no
     `permissionGuide` prop to drop.
   - `scripts/fork-test-files.json`: entries added after the backport are kept.
2. The merge of `c5904686e`, resolved with the rules of `specs/upstream-sync-3.18.0.md`.

## Conflict resolutions

22 files conflicted.

| File                                                                          | Resolution                                                                                                     |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `.gitignore`                                                                  | Both sides.                                                                                                    |
| `README.md`, `README.en.md`                                                   | Fork README kept; `README.en.md` stays deleted.                                                                |
| `apps/zcode-cli/packages/cli/package.json`                                    | Fork `dotenv ^18.0.7` plus upstream `@napi-rs/keyring 2.1.2`.                                                  |
| `packages/desktop/src/main/exportLogs.ts`                                     | Upstream CLI memory-diagnostics collection; fork English comments.                                             |
| `packages/desktop/src/preload/index.ts`, `packages/shared/src/channels.ts`    | Upstream `resetMicrophoneAccess` / `zcode:reset-microphone-access`; comments in English.                       |
| `packages/services/src/oauth/oauthService.ts`                                 | Upstream `isZaiOAuthProvider` redirect with `provider=zai_cn`; comment in English.                             |
| `packages/services/src/feedback/feedbackLogArchive.ts`                        | Upstream `cli-memory` content policy and sanitiser; fork keeps `ZCODE_UPSTREAM_BASE_VERSION` for `appVersion`. |
| `packages/shared/src/test-ids.ts`                                             | Upstream permission-guide test ids; comments in English.                                                       |
| `packages/ui/src/InteractionRequestOriginBadge.tsx`                           | Upstream meaning (description wraps in full), English comment.                                                 |
| `packages/ui/src/ToolCallBlocks/QueuedSummaryContent.tsx`                     | Upstream code (#185 same-key updates derive from props); English comments.                                     |
| `packages/ui/src/components/ai-elements/reasoning.tsx`                        | Upstream code (dispatch only when overflow flips); English comments.                                           |
| `packages/desktop/test/e2e/.../conversation-session-project-composer.test.ts` | Fork English placeholder plus upstream `no-drag` and focus assertions.                                         |
| `packages/ui/src/settingsCodePreview.tsx`                                     | Fork font pickers plus upstream macOS font smoothing row (after font size, before UI font).                    |
| `packages/ui/src/store/index.ts`                                              | Fork structure (broadcast wiring lives in `store/stateBroadcast.ts`); see below.                               |
| `packages/ui/src/v4/ConversationComposer.tsx`                                 | Fork side: one mic, fork dictation (owner decision 5).                                                         |
| `third-party/inventory.json`                                                  | Fork side, then regenerated.                                                                                   |
| four documents under `docs/`                                                  | Fork English kept, upstream changes ported in English (`specs/docs-compaction.md` "Upstream sync").            |

### Font smoothing in the fork store

Upstream adds `fontSmoothingEnabled` to the store and its inline broadcast code. The fork moved the
broadcast code to `store/stateBroadcast.ts`, which `store/index.ts` imports, so the helper cannot stay
private in `store/index.ts` without an import cycle. `applyFontSmoothing` and
`FONT_SMOOTHING_STORAGE_KEY` live in `lib/uiFontSize.ts`; `stateBroadcast.ts` broadcasts
`fontSmoothingEnabled`, applies a received boolean through the setter, and applies the class at start.
Storage key (`zcode-macos-font-smoothing`), class (`font-smoothing-enabled`) and default (on) are
upstream's. `packages/ui/test/fontSmoothingSync.test.ts` is kept from the backport and passes against
the upstream store.

## Fork follow-through

- `scripts/fork-test-files.json`: backport tests that no longer exist are removed
  (`memory-diagnostics-recorder`/`-writer`, `desktopMicrophoneAccessReset`,
  `feedbackLogArchive.cliMemory`, `oauthPollingCallback`, `cliMemoryDiagnostic`,
  `voiceInputFailureNotice`). Upstream ships its own tests for the same features
  (`apps/zcode-cli/packages/adapters/tests/memory-diagnostics/recorder.test.ts`,
  `scripts/test/installer-process-helper.test.mjs`, manual-review browser tests); they are not added
  to the fork manifest, following the rule that upstream-retired suites stay out.
- uk-UA: the backport's translations of the new keys (`settings.fontSmoothing*`,
  `voiceInput.permission.*`) are re-applied; en-US and uk-UA have the same keys.
- `fork-upstream-base.json` moves to `c5904686e` / 3.18.1 and `fork-upstream-migrations.json` is
  regenerated. Upstream added no migrations; only the pin changed.
- `packages/rust-cli`: upstream does not touch it. The regenerated `inbound.json` is unchanged and the
  bundled `zcode-builtin.json` still equals `config/provider/zcode-builtin.json`.
- Windows: upstream adds a native installer process helper (`scripts/windows-runtime-host/`) built by
  `scripts/build-windows-runtime-host.mjs`. The CMake generator is still "Visual Studio 17 2022", so
  the `windows-2022` runner pin in `fork-release.yml` stays (`specs/fork-release-versioning.md`).

## Behaviour after the sync

Upstream 3.18.1 behaviour, with these fork differences:

- The composer keeps one microphone, fork dictation; the upstream microphone permission guide is not
  reachable from the composer (owner decision 5 of the 3.18.0 sync).
- Memory diagnostics follow upstream (`apps/zcode-cli/packages/adapters/src/memory-diagnostics/`)
  instead of the reconstruction's `bootstrap/src/memory-diagnostics/`. The on-disk format and
  directory are upstream's, so files written by an earlier fork build stay readable.

## Verification

- `pnpm typecheck`, `pnpm lint` (0 errors), CLI `turbo run typecheck`, `pnpm architecture:check
--changed`, `pnpm db:migrations:check`: pass.
- `pnpm test:fork packages/ui/test/fontSmoothingSync.test.ts`: 5/5.
- PR CI and the fork-release build (macOS and Windows) after merge.
