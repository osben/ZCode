# pnpm 12 toolchain

## Contract

The repository and the embedded CLI workspace use Node 26.11.1 and pnpm 12.14.0.
`mise.toml`, both `packageManager` pins, Docker build inputs and development instructions
must agree. CI reads the root `packageManager` through pnpm/action-setup.

The root `pnpm-workspace.yaml` owns dependency overrides, patch declarations,
`nodeLinker: hoisted` and dependency build permissions. `.npmrc` contains registry/auth
configuration only. Bootstrap cleanup and third-party notice generation read patches
from the workspace YAML; package.json must not retain a second pnpm configuration.
The embedded CLI is installed through the root workspace so its workspace dependencies
resolve to the same graph. Existing build entry points that disable automatic dependency
verification retain that behavior. Root `verifyDepsBeforeRun: false` preserves pnpm 10
script semantics: validation and build commands never start an implicit install.

No application dependency versions or patch behavior are upgraded as part of this migration.
The ARMS patch target blob hash is corrected to match the existing patch output.
Lockfile changes must preserve package versions and integrity values except for pnpm's
own version record or required format normalization.

## Acceptance

- pnpm reports 12.14.0 from the root and CLI directories.
- A fresh root installation applies every declared patch and preserves overrides and
  the hoisted layout. A repeated frozen installation leaves the lockfile unchanged.
- Bootstrap removes only the patched hoisted targets declared in the workspace YAML;
  unrelated dependencies remain present. Notice generation includes those patch inputs.
- Typecheck, lint, architecture, formatting, unit/Node tests, hook integration and a
  workspace build run with pnpm 12. Limitations are reported explicitly.
- Linux and Windows validation is delegated to the existing CI jobs; local macOS results
  do not establish native dependency compatibility on other operating systems.

## Script lookup

pnpm 12 resolves scripts in the selected package. Desktop runtime preparation invokes
`prepare:remote-assets` from the repository root, where that script is declared; local
runtime scripts run from `packages/desktop`. The build must not depend on implicit
lookup of scripts in parent directories.

## Third-party inventory

pnpm 12's JSON dependency listing can prune repeated subtrees, including a production
peer first expanded below a development dependency. Read the complete listing, index
package names/versions and their edges, then walk only production/optional roots.
Development-only roots stay excluded; a runtime peer and its dependency closure stay
included even when another listing entry carries the expanded subtree.
