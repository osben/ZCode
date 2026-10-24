# Bash Readonly Classification

> Historical implementation plan (2026-06-27), kept for the Bash read-only classification
> contract. Implementation: `apps/zcode-cli/packages/core/src/tool/handlers/bash-command-parser.ts`,
> `bash-readonly-policy*.ts`, `bash-semantics.ts`, `bash.ts`; tests:
> `bash-permission.test.ts`, `bash-handler.test.ts`.

**Goal:** Bash read-only permission classification is conservative and independent from cwd
persistence. Classification may grant plan-mode permission and concurrency safety, but it must
never decide whether a successful Bash call persists cwd.

## Readonly Contract

- The command is parsed (`unbash` AST), then a conservative read-only classifier runs over the
  parsed simple commands, redirects, assignments, and argv. Too-complex ASTs, subshells and
  compound statements, unsafe bare assignments, unquoted variable expansion, unsafe UNC paths,
  unsafe redirects, unsafe env vars, and unsafe git/cd combinations are rejected before command
  names are checked.
- Per-command argv checks strip safe wrappers: `command`, `builtin`, `noglob`.
- A command is read-only only if every parsed simple command is safe by the direct argv policy
  or the command-text regex/policy.
- Safe read/list/search commands include `cat`, `head`, `tail`, `wc`, `stat`, `strings`, `file`,
  `grep`, `egrep`, `fgrep`, `rg`, `find`, `ls`, `tree`, `du`, `diff`, `pwd`, `whoami`, and
  trivial commands `echo`, `printf`, `true`, `false`.
- `find` is safe only without write/execution options: `-delete`, `-exec`, `-execdir`, `-ok`,
  `-okdir`, `-fprint`, `-fprint0`, `-fls`, `-fprintf`, `-files0-from`.
- Git auto-allow is guarded: `cd`/`pushd`/`popd` combined with git requires permission checks,
  never automatic read-only allow.
- Redirects are not blanket-unsafe: input redirects and fd merges can be safe, `/dev/null`
  output is safe; regular output redirects, `/dev/tcp`, `/dev/udp`, and Windows/UNC read
  redirects are unsafe.

## Runtime Semantics

- `isRuntimeReadOnlyBashCommand()` checks all parsed simple commands against the readonly
  policy; `isBashReadOnlyCommand()` and concurrency safety share the same contract.
- All known write-capable patterns stay denied in plan mode.

## Cwd Persistence (independent concern)

- cwd persistence is controlled by the execution context, not by read-only classification:
  main-thread foreground Bash persists a successful in-workspace cwd and resets out-of-workspace
  cwd to the workspace root (existing cwd policy); subagent/non-main scope never persists cwd.
- Successful foreground main-thread Bash always calls `decideBashCwdPolicy(...)`, including
  commands classified read-only.
