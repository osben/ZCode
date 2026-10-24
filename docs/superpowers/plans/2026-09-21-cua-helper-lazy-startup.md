# CUA Helper lazy startup — implementation plan (shipped)

Status: implemented (MR1/MR2, darwin MC-1/2/3 verified on machine; Windows MC-4~9 pending on-machine
validation). The product rules and invariants live in the spec:
`docs/cua-permission-broker/2026-09-21-cua-helper-lazy-startup-spec.md` — read it together with this
record. This file keeps the durable cross-repo contract and workflow constraints that produced the
implementation.

Full history: git show 7db9b1e9:docs/superpowers/plans/2026-09-21-cua-helper-lazy-startup.md

## What shipped

Agent-facing CUA credentials became pure data injection — Host startup and Agent spawn do zero
Helper IO. The Helper starts on first CUA call (SDK), or on explicit user action (settings page /
authorization flow), identically on macOS and Windows: darwin's M7 residual authorization-flow
warm-probe path was removed; win32 moved from "spawn acquire + waitForTransport(1s)" to "stable pipe
name + recipe env injection + SDK first-call self-fork"; the spawn-side wait/probe machinery
(`buildCuaProductHelperAgentEnv`, `CUA_PRODUCT_HELPER_SPAWN_READY_DEADLINE_MS` and companions) was
deleted. `getOrCreateDefaultCuaProductHelper` remains for getStatus/restart/resolver.

Implementation map: `packages/services/src/node.ts` (`resolveSpawnEnv` lazy branches, getStatus
win32, dead code removed) and `packages/services/src/cua-permission-broker/stableCuaTransport.ts`
(process-stable pipe singleton + win32 recipe cache). The plan-era source-guard tests
(`agentProxyEnv.test.ts`, `cuaPermissionBrokerProductAgentEnv.test.ts`) no longer reference
`resolveSpawnEnv` — they were reworked in later cleanups. Producer side (`zcode-cua` repo, not in
this monorepo): win32 fork branch in `src/tools/computer-use-runtime.ts`
(`ensureStandaloneHelperLaunched`), `ZCODE_CUA_WIN_HELPER_RECIPE_ENV` in
`src/broker/helperConstants.ts`, `warmHelperForBuiltInPlugin` prewarming removed from
`src/broker/server/cuaProductMcpResolver.ts`, test `computer-use-runtime.win-fork.test.ts`.

## Cross-repo contract

- Recipe env key: `ZCODE_CUA_WIN_HELPER_RECIPE` (producer `helperConstants` constant + the same
  literal in z-code; both sides must stay identical).
- Fork argv: `[entryPath, "--socket", <stable pipe name>, "--parent-pid", <hostPid>]` — exactly 4
  elements after the program, satisfying `parseWindowsDevHelperConfig` validation.
- Fork env: `ELECTRON_RUN_AS_NODE=1`, `[HELPER_ADDON_ENV]=addonPath` (`HELPER_ADDON_ENV` is
  `"ZCODE_CUA_HELPER_ADDON"`), plus the `commandEnv` whitelist. Fork is `detached`, `stdio:
  "ignore"`, `child.unref()`; failures are swallowed so the warmup retry loop reports the real
  broker error.
- The stable pipe name is minted once per process (`mintBrokerSocketPath`); recipe resolution
  (`resolveStableCuaWinRecipe` wrapping `resolveWindowsCuaRuntime`) caches success, returns null
  with a single warn on failure; spawn then fail-closes to `BROKER_UNAVAILABLE`.

## z-code repo working rules (still apply to follow-up work)

- Before each task: `node scripts/check-workspace-freshness.mjs` green and a clean
  `git status --short`; preserve others' changes. Required verification: `pnpm typecheck`,
  `pnpm lint`, `pnpm architecture:check --changed`, affected unit tests (root
  `pnpm test:unit:affected` does not replace CLI tests and desktop E2E).
- Conventional Commits with Why/What/Risk bodies; never `--no-verify`.
- New code carries no comments (user rule); root-cause explanations go in the commit message and
  spec only.
- Across worktrees always `git -C <path>`, never `cd`. Never run oxfmt on whole files (the
  `fmt:check` baseline is already red; format only lines you added).
- Linux is out of scope; platforms beyond darwin/win32 keep current behavior.

## zcode-cua producer repo working rules

- Commits need lore trailers (title + narrative + `Confidence:` + `Scope-risk:` +
  `Tested:`/`Not-tested:`); precheck
  `python3 scripts/validate_lore_commit.py --range origin/main..HEAD`. A missing item fails
  `commit_lore_review`, which silently skips dist/js_eval/helper_lifecycle/package_smoke/e2e — the
  pipeline looks 1-job-red but validated nothing.
- `dist/` is git-tracked and is the package: src changes must rebuild dist in the same commit.
  Before rebuilding, verify `node_modules` is not a symlink into the main clone (worktrees often
  are); if it is, `rm node_modules` (no `-rf`, no trailing slash) then
  `corepack pnpm install --frozen-lockfile`.
- The producer pin changes only through the script, run from the z-code repo:
  `pnpm --filter @zcode/zcode-cua-plugin bump:producer <full 40-char sha>` (export
  `ZCODE_CUA_REPO` for a producer worktree). Hand-editing the SHA in `pnpm-workspace.yaml` is
  rejected by `check-cua-baseline.mjs`; short prefixes create mixed SHAs; the pin target must
  already be pushed.
- Push both repos immediately after committing — concurrent sessions amending have eaten commits
  before; the pin trusts only the remote ref.

## Remaining validation debt

Windows full chain (fork/pipe/settings page, MC-4~7/9) has no on-machine run; producer CI status is
tracked on the remote branch. Desktop E2E case coverage for spawn timing is limited: assertions
that cannot observe spawn timing at the E2E layer, and all Windows paths, are marked "pending
Windows on-machine" in `docs/testing/cua-e2e-case-catalog.md` (per the e2e-case-lifecycle skill).
