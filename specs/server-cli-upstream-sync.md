# zcode-server-cli upstream sync (3.16.1)

## Scope

- Package: `packages/zcode-server-cli` only.
- Upstream range: `aac4755666d09fdcd70272fcf063c077a639015f` (v3.15.1) to `0a1fc56d` (v3.16.1), 49 changed files.
- Behavior comes from upstream: proxy-stdio, ingress token middleware, update handoff, stage archive and dependency packaging, remote asset release, shutdown wait, stop-failed recovery, migrate retry.

## Protocol

- `SERVER_CLI_PROTOCOL_VERSION` stays `1` (unchanged upstream). Controller and server-cli stay compatible.

## Ownership

- Fork-owned files, kept on purpose: `test/lock.test.ts`, `test/releaseDownload.test.ts`.
- Taken whole from upstream: `src/packaging/stage.ts`, `src/supervisor/supervisor.ts`, `test/supervisor.test.ts`, `test/packaging.test.ts`, `test/cli.test.ts`.
- Hand-merged: `src/runtime/paths.ts`, `src/platform/serviceManager.ts`, `src/server-core/http.ts`, `src/runtime/releaseInstaller.ts`, `src/packaging/stageCli.ts`, `src/cli.ts`, `test/daemonRegistration.test.ts`, `test/releaseInstaller.test.ts`, `scripts/verify-remote-ssh.mjs`.
- Fork English comments are kept where a conflict was comment-only. Upstream Chinese comments are kept as-is until a follow-up translation pass.

## Fork-specific rules that survive the merge

- Reinstall clears the uninstall fail-closed marker only after archive verification, immutable promote, pending release and launcher all succeed.
- The first target of a bootstrap run rebuilds the agent bundle; later targets may reuse it only after that build.

## Acceptance

- `pnpm --filter @zcode/server-cli test` passes.
- `pnpm typecheck` and `pnpm lint` pass with no new errors.
- `pnpm fmt:check` passes.
- Oversized `src/cli.ts` and `test/coreHttp.test.ts` are listed in `.staged-file-size-exemptions` until split.

Full history: `git show 01dd23cd:specs/server-cli-upstream-sync.md`
