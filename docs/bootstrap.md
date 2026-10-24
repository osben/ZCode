# Bootstrap commands

`pnpm bootstrap` is the default local initialization entry. It pulls the `apps/zcode-cli` submodule, installs dependencies, prepares desktop local runtime assets, and runs the bootstrap build; it does not prepare remote `mock-cdn` assets by default.

`pnpm bootstrap:with-remote` keeps the full initialization flow needed for remote debugging: submodule pull, dependency install, desktop local runtime assets and bootstrap build, then `pnpm --filter @zcode/server-cli exec tsx src/packaging/stageRemoteAssetsCli.ts` to generate `source-server-release.json` and the four platform archives. It no longer generates the legacy manifest/components.

To prepare Source Server assets alone, run `pnpm prepare:remote-assets`.

Linux SSH development uses `pnpm prepare:remote-assets:linux`, which builds only `linux-x64` and `linux-arm64` and skips submodule init, dependency install, and bootstrap builds of other workspaces. It reuses Source Server staging: build Server CLI/Core once, build the Agent and required plugin runtimes for the first target, and reuse that Agent for the second target; each target still carries the full Node, tools, dependencies, and plugin assets. The workspace must already have dependencies installed. It does not start Desktop and does not connect to or update a remote.

The Linux entry generates only the two complete archives needed for SSH bundle installation, no standalone component archives. Staging still computes each component's `paths`, `sha256`, and `sizeBytes` into the in-package manifest; it only omits the component `archivePath` and skips the second component hash, temp copy, and compression. The all-platforms entry keeps generating component archives. Restaging cleans that target's old component archives so history files are not mistaken for this round's output; full asset assembly, plugin runtime and license-notice validation, bundle SHA/size, and descriptor publishing rules are unchanged.

The new command defaults `ZCODE_ENV` to `production` when unset or blank, matching `pnpm dev:desktop`; an explicit value is trimmed and lowercased and only `test` / `production` are accepted; invalid values fail before any build or artifact change. For the test environment, run `ZCODE_ENV=test pnpm prepare:remote-assets:linux`, then start `pnpm dev:desktop:test`. `prepare:remote-assets` and `bootstrap:with-remote` still build all four platforms.

```text
invalidate old descriptor -> build Server CLI/Core -> Linux x64 (builds Agent)
                           -> Linux arm64 (reuses Agent) -> publish Linux dual-arch descriptor
per target: asset assembly + validation -> one component hash -> manifest -> bundle compression (no standalone component archives)
```

The two archives are written to `packages/desktop/mock-cdn/releases/<version>/`; `source-server-release.json` contains only this round's two Linux targets with their SHAs/sizes and never merges old macOS entries. If any target fails, no new descriptor is published; existing macOS archive files are not proactively deleted but are not referenced by that descriptor. To restore macOS verification, re-run the all-platforms entry. Build commands must not concurrently write the same workspace's release directory. Regression tests cover the real CLI's target selection, Agent reuse parameters, environment passing, failure abort, dual-arch archive/descriptor publishing, and old-entry eviction; full remote builds or real-SSH runs do not replace these tests. The component-archive optimization must additionally cover: the Linux entry passing the skip parameters, the all-platforms entry keeping its behavior, complete packages installing, component hashes matching default packaging, old component archives being cleaned, and failure when required assets are missing.

When `bootstrap:with-remote` prepares a desktop official plugin runtime, it must first clean the plugin's old `dist`; if the plugin root has a `tsconfig.json`, run the TypeScript compilation before runtime bundling and artifact validation. The docs plugin's source lives in the shared `office-runtime`; without its own tsconfig it runs the declared build script directly. The file-system APIs used for cleaning must be explicitly imported; a clean or build failure propagates to the entry, and stale artifacts must never be reused. Regression acceptance runs the real clean function, covering plugins with and without tsconfig and old `dist` present or absent, confirming cleaning happens before the build command.

## Product environment of remote initialization

`bootstrap:with-remote` selects the product environment at the entry: unset or blank `ZCODE_ENV` selects `production`, matching the later `pnpm dev:desktop`; explicit `test` / `production` values are trimmed, lowercased, and passed to all build subprocesses. Invalid values must fail before dependency install, cleaning, or building. Local runtime, Source Server Core, and the remote Agent must use the same selection — a sub-build may never fall back to the test environment.

```text
before: bootstrap:with-remote -> no env selected -> remote package test
        dev:desktop           -> production -> production credentials sent to the test model endpoint -> 401
after:  bootstrap:with-remote -> entry selects production -> local and remote artifacts in the same environment
        dev:desktop           -> production -> production credentials match the model endpoint
```

For test-environment integration, run `bootstrap:with-remote` with `ZCODE_ENV=test` first, then `pnpm dev:desktop:test`. After explicitly selecting the test environment, a plain `dev:desktop` still means production and does not rebuild or convert the remote package automatically. Existing test-environment archives must be rebuilt and the remote updated to switch to production.

Plain `bootstrap`, standalone `prepare:remote-assets`, and the generic builders keep their existing environment-selection rules; this entry constraint changes neither the Provider Provisioning built-in config authority, the runtime protocol, nor task recovery semantics. Regression acceptance covers default/blank values, both explicit environments, invalid-value early failure, and plain bootstrap's original behavior, intercepting build subcommands to verify the environment the real entry passes and the selected Built-in Provider model endpoint.

## Build boundary of the Agent shared migration module

The CLI, desktop agent, and SEA reuse the alias config of `apps/zcode-cli/packages/cli/scripts/build.mjs`. `@zcode/shared/sqlite-migrations` must resolve exactly to `packages/shared/src/node/sqliteMigrations.ts` and be bundled into the Agent bundle; otherwise the generic `@zcode/shared` alias appends the subpath to `src/index.ts` and the bootstrap build fails. The build regression test uses the real session migration entry with esbuild, verifying the shared implementation is inlined with no leftover external dependency on that subpath. The change adjusts build resolution only: no change to migration SQL, checksums, ledger, or execution order.
