# Pre-commit Quality Gate

## Scope

Defines the repository-level Git pre-commit quality gate, maturity `L1 Local Workflow Contract`. It is
a fast local guard before commit and does not change the runtime agent loop, tool runtime, permission
system or release path.

## Goals

- Run root `pnpm lint` automatically before a local commit.
- Run root `pnpm test` automatically after lint passes.
- Reuse existing npm scripts; the hook does not duplicate lint or test rules.
- Manage Git hooks with Husky, the standard setup for a Node.js CLI repository.
- Add no `ZCODE_` environment variable, read no external config, touch no database schema.

## Non-goals

- It does not replace CI. CI still runs lint, test, typecheck and release verification independently.
- It does not run build, coverage or end-to-end tests, to keep the normal commit path light.
- It does not bypass explicit Git operations; maintainers can still skip the hook with native Git
  commands.

## Execution contract

The hook is `.husky/pre-commit` and runs in this fixed order:

1. `pnpm lint`
2. `pnpm test`

If either command exits non-zero the commit fails and that command prints the error detail. The hook
does not swallow errors, rewrite exit codes or generate extra files.

## Installation contract

The root `package.json` `prepare` script runs `husky` so hook shims are initialized after dependency
installation. Husky is a root devDependency, not declared per workspace package.

## Cross-platform constraints

- The hook script calls only `pnpm` and existing npm scripts; no POSIX-only pipes, redirection, path
  joining or shell string composition.
- Git for Windows runs Husky hooks through its bundled shell; the script stays minimal to limit shell
  differences.
- The actual lint/test logic stays in repository scripts and Turbo, which handle cross-platform
  concerns.

## Error behavior

- `pnpm lint` fails: stop, do not run test, the commit fails.
- `pnpm test` fails: the commit fails.
- Husky not installed or hooks not initialized: `prepare` repairs this on dependency install. A user who
  disables Git hooks is doing local Git configuration; the code does not compensate.

## Test coverage

- `npm run lint`
- `npm test`
- Manually verify `.husky/pre-commit` is executable and calls `pnpm lint` then `pnpm test` in order.
