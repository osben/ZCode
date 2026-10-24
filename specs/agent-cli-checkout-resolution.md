# Local agent CLI resolution stays inside the current checkout

The Host (desktop utility process, `pnpm dev:web` server) resolves the default local ZCode agent
command in `resolveDefaultZCodeAgentCommand` (`packages/services/src/zcode-agent/zcodeAgentProcessManager.ts`).
Git worktrees live inside the main checkout (`<repo>/.claude/worktrees/<name>`); without a checkout
boundary the dist search walked out of a worktree that had never built the CLI and ran a stale build
from the main checkout, so runtime changes made in the worktree silently never ran.

## Rule

1. **Owner.** `findUpward` in `zcodeAgentProcessManager.ts`, used by the agent command resolver and
   the dev stdio tap script lookup, decides the search range. Callers do not walk directories
   themselves.
2. **Boundary.** Walk up from `process.cwd()`. The checkout root is the nearest ancestor (including
   `cwd` itself) that contains a `.git` entry — a directory in a main checkout, a file in a linked
   worktree or submodule. Every directory from `cwd` up to and including that root is searched;
   nothing above it is.
   - `package.json` / `pnpm-workspace.yaml` are not boundaries: every package has a `package.json`,
     and `apps/zcode-cli` has its own `pnpm-workspace.yaml`, which would hide the
     `apps/zcode-cli/...` paths.
3. **No checkout.** When no ancestor contains `.git` (packaged app, SSH/WSL host, source tarball),
   the walk continues to the filesystem root, as before.
4. **Order within the range.** Env override (`ZCODE_AGENT_SERVER_COMMAND`) → checkout dist
   (`zcode.cjs`, or the bytecode variant when enabled) → checkout source (`src/main.ts` run by the
   checkout's `node_modules/.bin/tsx`) → Electron runtime bundle → deployed native binary. Dist still
   wins over source inside one checkout.
5. **Source without tsx.** When the checkout has the CLI source but no `node_modules/.bin/tsx`
   (dependencies not installed), the monorepo step returns no command and the resolver falls through
   to the packaged fallbacks, but logs a `warn` naming the reason, so a fallback build is never
   chosen silently. A parent checkout's tsx is never borrowed.

## Acceptance scenarios

1. Parent repo (`.git` directory) has a CLI dist; a nested worktree (`.git` file) has CLI source and
   `node_modules/.bin/tsx` but no dist; `cwd` is inside the worktree → the command is the worktree's
   tsx running the worktree's `src/main.ts`.
2. Same tree, worktree also has a dist → the command is `process.execPath` running the worktree's
   `dist/zcode.cjs`.
3. Same tree, worktree has source but no tsx → the parent dist is not used; the resolver falls
   through to the Electron/deployed fallbacks and logs a warning.
4. No `.git` anywhere above `cwd` (existing sandbox tests, packaged hosts) → behaviour is unchanged:
   the walk reaches the filesystem root.
