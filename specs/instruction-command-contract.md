# Instruction command contract (`pnpm`/`node` citations in agent docs must exist)

## Background (current source facts)

- Agent instructions (`AGENTS.md`, `CLAUDE.md`, `.agents/skills/*/SKILL.md`, root `CONTEXT.md` /
  `DESIGN.md`), `specs/**/*.md` and `apps/zcode-cli/docs/design/v2/**/*.md` cite `pnpm` and `node`
  commands as verification steps. When a cited command stops existing (a root script is renamed,
  a script file moves, a filter target is unlinked), every doc that cites it silently rots and
  agents report phantom verification steps.
- Concrete cases found in this repository: `pnpm --dir apps/zcode-cli check` (nested-workspace trap:
  `apps/zcode-cli` has its own `pnpm-workspace.yaml`, so `--dir` scopes pnpm to the inner workspace
  and its root-only scripts like Turbo are not resolvable), `node scripts/build-sea.mjs` cited at
  repo-root semantics while the file lives at `apps/zcode-cli/packages/cli/scripts/build-sea.mjs`,
  and `pnpm build:lite` cited after the script was removed.
- The check is static: it reads tracked `package.json` files (scripts and dependency names), never
  `node_modules`, and checks file paths on disk for `node <path>` citations.

## Product rules

- **Scope (v1)**: every git-tracked `AGENTS.md` and `CLAUDE.md` at any depth; repo-owned skill docs
  `.agents/skills/*/SKILL.md` and `apps/zcode-cli/.agents/skills/*/SKILL.md`; root `CONTEXT.md` and
  `DESIGN.md`; `specs/**/*.md`; `apps/zcode-cli/docs/design/v2/**/*.md`.
  - Excluded: vendored skill trees (`.agents/skills/react-best-practices/**`,
    `apps/zcode-cli/.agents/skills/vercel-react-*/**`) because they are not authored here; plugin
    skill trees `apps/zcode-cli/packages/*/skills/**`; this spec itself, which quotes failing
    commands as examples.
  - `docs/**` is **deferred to phase 2** (large, mostly upstream-prose; not checked in v1).
- **Extraction**: command candidates are (a) lines inside fenced code blocks (```or ~~~ fences)
and (b) inline code spans in non-fenced text. Each candidate line is split on`&&`, `||`and`;`into segments; a segment gets its leading`$ `prompt prefix and leading`VAR=value` assignments
stripped. A segment is skipped when it contains a placeholder character (`< { $ \* [ |`) — those
are templates, not runnable commands — or when it starts with neither `pnpm`nor`node`.
A `cd <dir>` segment does not produce a command; it sets the working directory for the
remaining segments of that line (`cd packages/ui && node --import tsx --test test/x.test.ts`resolves`test/x.test.ts`against`packages/ui`).
- **Parsing (`pnpm`)**: leading global options are consumed: `--filter <arg>` / `-F <arg>`
  (repeatable; `...`/`^...` name-suffix forms and `./relative` path selectors are accepted),
  `--dir <arg>` / `-C <arg>` (also `--dir=<arg>`), `-r`, `-w`, `-s`. The first remaining token is
  the command: `run <script>` or a bare `<script>`; everything after it is script arguments and is
  ignored. `pnpm exec`, `pnpm <built-in>` (`install i add remove update why list dlx create store
outdated audit rebuild link publish pack pkg config env root bin patch dedupe deploy
approve-builds`) and `-v`/`--version`/`--help` are not verified in v1.
- **Parsing (`node`)**: the first non-option token after `node` is treated as the entry-file path.
  Flags that take their value as a separate token (`--import`, `--require`, `-r`, `--loader`,
  `--experimental-loader`) consume that token; a `node` invocation that passes
  `-e`/`--eval`/`-p`/`--print` (inline code, not a file) is skipped.
- **Resolution**: a `--filter` argument must equal the `name` of some tracked `package.json` (after
  stripping `...`/`^` prefixes/suffixes), or be a `./path` selector for a directory that contains a
  `package.json`; a `--filter` argument containing glob characters is not verified. A `--dir`/`-C`
  argument must be a directory containing a `package.json`. A bare script (or `run <script>`)
  resolves against the **root** `package.json` **or** the owning package of the citing doc — the
  nearest tracked `package.json` at or above the doc's directory (for `apps/zcode-cli/**` docs the
  owner is `apps/zcode-cli`; root-owned docs resolve against the root only). A bare token passes if
  it is a script of a resolved package or a binary declared in the `dependencies`/`devDependencies`
  of the resolved or root package. `node <path>` passes when the file exists relative to the
  repository root or to the doc's owning package directory.
- **Nested-workspace rule**: `--dir`/`-C` may not target a directory that contains its own
  `pnpm-workspace.yaml` (`apps/zcode-cli` does). Such a citation fails with a message suggesting
  `--filter <name>`, the `name` from that directory's `package.json` (for `apps/zcode-cli`:
  `--filter zcode-cli`). Reason: inside the nested workspace, pnpm cannot resolve root-level
  dependencies, and root script forwarding silently misbehaves — `--filter` from the repository
  root is the supported form.
- **Allowlist**: entries are keyed `"<file>::<command>"` with an inline reason comment per entry
  (same pattern as `scripts/check-test-copy.mjs`). An entry that matches nothing (the citation was
  fixed or reworded) is itself a failure — the allowlist must not accumulate history.
- **Output**: `scripts/check-instruction-commands.mjs` exits 1 and lists each violation as
  `file:line: command` plus a reason line. Structure: pure functions `extractCommands(markdown)`,
  `resolveCommand(command, ctx, ownerDir)` and `collectScope(root)` are exported for tests; only
  `main()` touches the repository.

## Acceptance scenarios

1. A citation of a root script that does not exist fails, naming the file, line and command.
2. An unknown `--filter` target fails.
3. `pnpm --dir apps/zcode-cli <script>` fails suggesting `pnpm --filter zcode-cli <script>`.
4. `pnpm vitest run` passes (root `devDependencies` declares `vitest`).
5. `pnpm install` and `pnpm pkg set x=y` pass (built-ins are not verified).
6. `node scripts/does-not-exist.mjs` fails; `node scripts/check-instruction-commands.mjs` passes.
7. A stale allowlist entry (no matching violation) fails the check.
8. The current repository passes except the known `apps/zcode-cli/AGENTS.md` `--dir` citations
   that the integrator rewrites in the same change series.
