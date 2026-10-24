# zcode-cua merged into the z-code monorepo

## Goal

`@zcode/zcode-cua` (the CUA producer: MCP server, Helper runtime, `ax_native.node`, node_repl SDK, official
Skill) moved from the standalone repo `git.example.invalid/codegeex/zcode-cua` into z-code's
`packages/zcode-cua/` and is an ordinary workspace package:

- Consumers use `workspace:*` uniformly; there is no git SHA pin and no private-repo credential such as
  `ZCODE_CUA_GIT_TOKEN`.
- `dist/` is not in git; `pnpm build:cua` produces it, and root `prepare` and CI build it after install.
- CUA unit tests, evals and real-machine e2e run in z-code CI; the z-code desktop packaging uses the
  in-workspace build output directly.
- License follows z-code (Apache-2.0) and toolchains such as TypeScript align with the root repo.

Import baseline: `zcode-cua@4a3c507dd16f3ed840e87bc92e709ce339e6a4f3` (v0.6.4), landed as one squash snapshot
commit with an `Imported-From` trailer recording the source.

## Layout

```
packages/zcode-cua/
  src/            TypeScript source (MCP server, broker, Helper, SDK); src/native/ is the ax_native N-API source
  binding.gyp     ax_native.node build description
  test/           vitest unit tests (the cua project of the root vitest)
  tests/          python unittest, parity fixtures (only samples < 1MB kept)
  evals/          zcode-gui-eval (own lockfile, not in the workspace)
  scripts/        build / native / live smoke / real-machine e2e gate
  plugin/         the only source of truth for the official Skill (SKILL.md) and plugin.json
docs/cua/producer/ outward-valid CUA producer docs
```

## Not carried over

| Content | Reason |
| --- | --- |
| `dist/` | now a build artifact |
| Standalone-repo CI (`.gitlab-ci*`, lore trailer, merge gate, AI review, dist freshness, package smoke) | replaced by z-code CI and MR conventions |
| Remote smoke (Linux/Windows remote act-verify, remote frame-pixel gate) | depends on private remote machines, not reproducible in-repo |
| Large parity fixtures (11 sample sets >= 1MB and derivatives) | repo size; oracles trimmed in step, the remaining samples still cover all encoding paths |
| Internal process docs (test evidence, plans, known issues, CI flow) | valid only for maintaining the old repo |
| Original MIT LICENSE, standalone lockfile | license and dependency lock follow z-code |

## Version and pin

- The single source of truth for the CUA version is `version` in `packages/zcode-cua/package.json`; it is still
  inlined into `SERVER_VERSION` at build time.
- The pin toolchain is deleted: `bump-zcode-cua-producer.mjs`, `check-cua-baseline.mjs`,
  `sync-skill-from-zcode-cua.mjs`, `upstream.json`.
- `check-version-coherence.mjs` reads the workspace package's `package.json` and `plugin/` directly; the
  plugin-side Skill syncs from `packages/zcode-cua/plugin/` and the 14 KiB budget guard stays.
- The Windows Helper artifact name `@zcode/zcode-cua-helper-runtime` stays as a release artifact name and is no
  longer an npm dependency alias.

## Build chain

```
pnpm install
  └─ zcode-cua install hook: node-gyp builds ax_native.node (best-effort on non-macOS / failure)
  └─ root prepare: husky && pnpm build:cua
        └─ tsc -b tsconfig.build.json && node scripts/build.mjs  → packages/zcode-cua/dist
consumers (desktop / services / cli adapters / core / node-repl-host / zcode-cua-plugin)
  └─ resolve @zcode/zcode-cua → dist/** through the workspace symlink
```

`typecheck`, `test:unit`, `dev:desktop`, `build:cua-helper` and the CI install step all depend on `dist`
already existing.

The eval dependency regression test checks both that CI install precedes evaluator execution and that root
`prepare` calls `build:cua` pointing at the workspace producer. CI no longer runs `pnpm build:cua`
separately, so the test must not keep requiring that removed command.

In-package lint uses its own `packages/zcode-cua/.oxlintrc.json` (oxlint default rules, same as the old repo)
and does not inherit the root config's `max-lines`; root `pnpm lint` skips this package through
`ignorePatterns`.

## CI

| job | Trigger | Content |
| --- | --- | --- |
| `cua:unit:macos` | MR touching `packages/zcode-cua/**` (released via `approve:merge-request`) or manual web/api pipeline | install (root prepare builds dist) -> typecheck + oxlint -> vitest cua project |
| `cua:eval:macos` | same | zcode-gui-eval definition validation and node test, all python unittest |
| `cua:real-e2e:macos` | manual under MR / web / api, failure does not block | start the product broker and run the CUA e2e gate on a real machine |
| Helper build/packaging | existing rules | producer SHA from `CI_COMMIT_SHA`, version from the workspace package |

Docker / Jenkins no longer rewrite git URLs or inject zcode-cua credentials (Jenkins `zcode-cua.gitlab-read`
can be reclaimed):

- web-share: runtime and build time involve no CUA; the image has no git and does not copy
  `packages/zcode-cua`.
- web-remote-control v4: puts `packages/zcode-cua` in the build context, runs `pnpm install --ignore-scripts`,
  then `pnpm build:cua`, then builds Web.

Both images install with `--ignore-scripts`, which naturally skips native compilation.

## Verification

- After `pnpm install`, `packages/zcode-cua/dist` and `ax_native.node` exist.
- `pnpm typecheck`, `pnpm lint`, `pnpm test:unit` (including the cua project) and `pnpm verify:pre-push` pass.
- `pnpm build:cua-helper` produces the Helper.
- `ZCODE_CUA_DEV_MODE=1 pnpm dev:desktop` starts the Helper and completes a real CUA call.
