# Shared Architecture Governance and AI Governance

## Goals

Architecture rules are a repository-wide capability, not part of any single business refactor. All code changes follow the same path:

```text
Code change → policy parsing → dependency graph and change closure → rule checks and ratchet → reading package and report
```

Rules apply only to modules with `managed: true` (`managedOnly`); existing modules remain unmanaged and are not subject to structural rules. The guarantee that new code follows these constraints comes from `unmanaged-new-file`: source files that are newly added relative to the comparison baseline and first entered the repository after `global.newFilesEnforcedSince` must sit inside a managed module, otherwise they are blocked. Untracked files are always treated as new. The effective date keeps long-lived branches from being retroactively affected and avoids branches writing existing-violation entries into the shared baseline, which would cause conflicts. Existing violations are recorded in a deterministic baseline; new violations block changes, and the baseline can only be updated through an explicit command and PR review.

### Admitting Existing Code from a Pinned Upstream

`build:desktop:app` sets `GIT_DEPTH: "0"` at job level so the Runner fetches full history before the architecture check. A shallow clone truncates the ancestor chain and would make an already-merged admission commit look unmerged. This setting applies only to that job and does not change the fetch depth of other jobs; the checker still strictly verifies commit ancestry.

When merging an upstream that contains newer source but has not yet enabled new-file governance, the policy may register the upstream `commit`, the full SHA of `previousHead` before the merge, and the admission reason `reason` in `global.acceptedUpstreamCommits`. Both commits must exist locally, and each must be an ancestor of HEAD. Pre-commit validation also accepts ancestors of the current Git `MERGE_HEAD`, so a `--no-commit` merge can be verified before it is committed. Branch names, abbreviated SHAs, missing objects, or commits that are not part of the current merge make the check fail; the checker does not fetch or update the policy automatically. Admission covers only paths that exist in the upstream and did not exist before the merge; it does not extend to modifications of pre-existing files.

Only the `unmanaged-new-file` classification uses the following. A candidate file must already be tracked, exist at the same path in the pinned commit, and have Git content and file mode in both the index and the working tree that match that commit before it can be admitted as existing upstream code. Modifications, renames, additions, and untracked files still require a managed module. Edits made after a merge conflict count as modifications; authorship, commit messages, path prefixes, or dates are never used in place of content verification.

```text
Real push / CI change scope -> new-file candidates
  -> verify the pinned upstream commit is merged
  -> same path, with index and working tree both matching upstream: exempt only from new-module registration
  -> other candidates: apply the new-module registration rule
Full change scope -> existing structure, dependency, cycle, type, and test checks
```

Admission does not change the push/CI comparison base, does not change the changed closure, does not write violations into `.architecture-baseline.json`, and does not exempt other rules in managed modules; the original effective date is unchanged. When a registered pinned upstream is merged again, paths that were introduced by an earlier admission commit may match the verbatim content of any registered upstream, but they must still match the index, working tree, and mode. Later local edits that are no longer new relative to the push base require module registration again. Acceptance covers verbatim merges, repeated merge updates, conflicting modifications, index/working-tree mismatches, renames, untracked files, later modifications, invalid commits, and continued blocking by other rules.

## Sources of Rules

- The root `architecture-policy.yaml` is the organization-level policy: module paths, layers, allowed edges, global thresholds, and exceptions.
- A module's `module.ts` declares its local dependencies: `id`, `requires`, `provides`, and public entry points.
- The actual import graph is generated from source code and must not be maintained manually.
- The feature graph describes product capabilities and their impact surface only; it does not enforce architecture rules.

The policy file and module declarations must validate one another (rule `manifest-policy-mismatch`). Modules not covered by the policy and unknown dependencies in module declarations are prohibited.

Import edges follow the real resolution behavior of Node and TypeScript: relative paths, `imports` in `package.json` (`#src/*`), `paths` in `tsconfig.json` (`@/*`), and workspace package names with `exports` (conditional exports and `dist/` targets map back to `src/`). Cross-package `@zcode/*` imports create edges, so the module-dependency, deep-import, cycle, and layer-direction rules cover them (regression-tested).

Configuration is read with TypeScript's JSONC parser, which supports block comments, end-of-line comments, and trailing commas, and preserves globs inside strings. Comments must not be removed with regular expressions: `@/*`, `#src/*`, and later patterns such as `src/**/*.ts` or script arguments like `cache-*/**` would be misread as comments, causing a whole package or path mapping to disappear. Regression tests require both alias styles to trigger real layer-direction violations.

## Rules

The rules engine checks layer direction, module dependency declarations, public entry points, circular dependencies, UI/Domain implementation boundaries, required module files, file and contract sizes, public method counts, and lint disables. The owner field is included in reports. Write authorization for state must use the same rule interface after the relevant state module declares it in its manifest. Rule IDs and repair guidance are maintained under `scripts/architecture`; `AGENTS.md` only provides the entry point.

## Commands and Execution

```text
pnpm architecture:check
pnpm architecture:check --changed
pnpm architecture:report
pnpm architecture:baseline:update
pnpm architecture:context <module-id>
pnpm architecture:adopt <module-id> --root <dir> [--layer domain|app|adapters|ui] [--owner <group>]
```

The comparison base for `--changed` is chosen in this order: `--base <sha>` or `ZCODE_PRE_PUSH_BASE` > CI merge-request variables (such as `CI_MERGE_REQUEST_DIFF_BASE_SHA`) > the remote sha from pre-push stdin > `@{upstream}` > the default-branch merge-base (maintained in `scripts/architecture/default-branch.mjs`, same order as `run-affected-engineering-tests`, with `origin/staging` preferred) > `HEAD`. The second line of the report prints the base actually used. The base is never just `git diff HEAD`: in a clean CI checkout and during pre-push that diff is empty and the gate would check only cycles. A 2026-09 review found that the first version used only `git diff HEAD` and has been fixed.

`architecture:adopt` registers a directory as a managed module: it infers `requires` from real imports, generates the missing four-file skeleton (`module.ts`, `contract.ts`, `contract.example.ts`, `CONTRACT.md`) without requiring or generating App unit tests, and registers the module in the policy file while preserving comments. It exists so that registering a module is cheaper than bypassing the rules.

Local development and CI use the same checker. `--changed` resolves the complete dependency graph but blocks only on this change and its required impact closure; global policy, circular dependencies, and baseline growth are always checked. CI must not refresh the baseline automatically. `baseline:update -- --changed` replaces only entries within the changed closure and does not drop records outside it. File paths in violations and in the baseline are repository-root-relative POSIX paths, so they are stable across machines. The checker's own regression tests run with `pnpm test:architecture`, which is wired into `verify:pre-push` and the CI lint job.

### Git File Enumeration and CI Cache

File enumeration must survive large untracked caches (the macOS packaging job once overflowed `execFile`'s default buffer on the Runner's retained `.electron-builder-cache`). The behavior lives in the change-collection entry point in `scripts/architecture/index.mjs`; it does not change business modules, policy, or the baseline.

- Root-level `.electron-builder-cache/`, `.electron-cache/`, `.pnpm-store/`, and `.npm-cache/` are persistent CI caches and are added to `.gitignore`. Keep the CI cache paths and cleanup exclusions; do not solve the problem by deleting caches on every run.
- Tracked files are still compared with `HEAD`, and untracked files still follow Git ignore rules. Both commands use NUL-delimited streaming output to avoid a fixed `maxBuffer` limit, without trimming path whitespace or corrupting non-ASCII filenames.
- The collection entry point merges and deduplicates filenames. If a Git process fails, the check fails; failed or partial output must not be treated as an empty change set. Do not add caches, versioning, or background processes, and do not change CI baseline comparison semantics.

```text
Git diff / untracked-file enumeration
  -> stream-parse NUL-delimited paths
  -> merge and deduplicate after both processes succeed
  -> existing architecture check
Either Git process fails -> check fails
```

Verification uses a temporary Git repository covering more than 1 MiB of tracked and untracked changes, cache ignores, special paths, and propagation of Git failures. This affects only development/CI checks.

## Agent Workflow

[architecture-governance skill](../../.agents/skills/architecture-governance/SKILL.md) applies to code changes; skip it for documentation-only tasks. Before changing code, identify the expected module and check the current baseline; check again after the change. For cross-module changes, changes to state ownership, or unclear contracts, generate an `architecture:context` reading package. For local changes with clear contracts, read only the relevant contracts, specs, and tests. Specs, verification scope, and completion criteria follow the [root AGENTS.md](../../AGENTS.md); they are not defined again here.

The reading package is generated from code and policy. It includes the target module's `module.ts`, `contract.ts`, examples, a short `CONTRACT.md`, direct dependency contracts, owner, and allowed edges; it does not copy the full implementation.

## Rollout Order

First establish the policy, dependency graph, baseline, and report format. Then enable high-confidence structural rules. Next, use Project/Session as complete examples to validate contracts, module manifests, and reading packages. Finally, expand to areas such as workspace identity, identity, model, automation, and plugins/MCP. Do not create a separate governance gate for an individual area.

## Explicit Boundaries

Do not introduce an unvalidated general-purpose IoC/Event Center, maintain a second manually curated OWNERS dependency graph, use the feature graph as policy, or perform a one-time repository-wide migration. Code volume does not need to be balanced across layers; acceptance focuses on whether decision points, boundaries, races, and reading scope are well-contained.

## Todo103 Integration Boundaries

The policy's module directory must include `packages/provider/src` and `packages/provider-node/src`, which were extracted by the current refactor, so the checker can discover their source and generate the corresponding reading packages. Keep them registered as unmanaged, like the other existing modules in this round. Do not expand the integration into a repository-wide contract/manifest migration or refresh the baseline automatically. Zero violations under the current `managedOnly: true` setting means only that the enabled rules reported no errors; it does not prove that all existing cross-domain dependencies passed mechanical checks. Continue manual review in both directions for the Provider/Selection intersection.

The CLI's independent lint also admits existing `max-lines` violations in pinned upstream files verbatim. After running each package's original oxlint arguments, only that diagnostic is admitted, and only for files whose path, content, and mode match the pinned commit and both the index and the working tree. Other lint rules still block. Files with local changes on this branch, new files, and missing or unmerged upstream commits receive no admission. The admission list is generated from Git on every run; no per-file line-count baseline is maintained and no disable comments are written into source.

The CLI `lint` entry enumerates the oxlint commands declared in `packages/tools` and preserves each package's cwd, arguments, and configuration. Non-oxlint commands or unparseable output fail explicitly, so a new package is never silently skipped. The result reports both the admitted existing line-count diagnostics and the errors that still block.

Oversized CLI session storage, migration, gateway, and startup assembly code keeps its original implementation rather than being split into method fragments that share all internal state. Protocol-independent model context and residency lease move to the session-execution public entry point, removing V4's reverse dependency on the old protocol directory. The original runtime and records remain the state owners.

### Line Count Rule (ruling of 2026-10-10)

The default limit for ordinary source files is raised from 400 to 800 lines. Module registration, dependency direction, public entry points, circular-dependency, and contract checks remain strict; do not split files into fragments that share all internal state just to satisfy the line-count metric.

Existing CLI files over 800 lines in this integration, and an existing remote-connection hook moved into a module, are registered by exact path as line-count warnings in the root `.oxlintrc.json`. They keep the diagnostic but allow the commit. Other files over 800 lines still error, and other lint rules are not downgraded. Verbatim line-count admissions from a pinned upstream still go through fixed-commit content verification, not a directory-level exemption.

The original line-count disable in the remote-connection hook is replaced by a warning on its exact path. The architecture gate registers only the line-count exception for that file; module dependencies and other rules still apply.
