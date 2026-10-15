# Shared Architecture Governance and AI Governance

## Goals

Architecture rules are a repository-wide capability, not part of any single business refactor. All code changes follow the same path:

```text
Code change → policy parsing → dependency graph and change closure → rule checks and ratchet → reading package and report
```

The first version covers `packages`, `apps`, desktop, web, server, and CLI. Existing violations are recorded in a deterministic baseline; new violations block changes, and the baseline can only be updated through an explicit command and PR review.

## Sources of Rules

- The root `architecture-policy.yaml` is the organization-level policy: module paths, layers, allowed edges, global thresholds, and exceptions.
- A module's `module.ts` declares its local dependencies: `id`, `requires`, `provides`, and public entry points.
- The actual import graph is generated from source code and must not be maintained manually.
- The feature graph describes product capabilities and their impact surface only; it does not enforce architecture rules.

The policy file and module declarations must validate one another. Modules not covered by the policy and unknown dependencies in module declarations are prohibited.

## Rules

The rules engine checks layer direction, module dependency declarations, public entry points, circular dependencies, UI/Domain implementation boundaries, required module files, file and contract sizes, public method counts, and lint disables. The owner field is included in reports. Write authorization for state must use the same rule interface after the relevant state module declares it in its manifest. Rule IDs and repair guidance are maintained under `scripts/architecture`; `AGENTS.md` only provides the entry point.

## Commands and Execution

```text
pnpm architecture:check
pnpm architecture:check --changed
pnpm architecture:report
pnpm architecture:baseline:update
pnpm architecture:context <module-id>
```

Local development and CI use the same checker. `--changed` resolves the complete dependency graph but blocks only on this change and its required impact closure; global policy, circular dependencies, and baseline growth are always checked. CI must not refresh the baseline automatically.

### Git File Enumeration and CI Cache

The macOS packaging job on 2026-09-10 failed during file enumeration: the Runner's retained `.electron-builder-cache` was not ignored by Git, and `git ls-files --others --exclude-standard` exceeded `execFile`'s default buffer. The fix belongs in the existing change-collection entry point in `scripts/architecture/index.mjs`; it does not change business modules, policy, or the baseline.

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

Verification uses a temporary Git repository to cover more than 1 MiB of tracked and untracked changes, cache ignores, special paths, and propagation of Git failures. This affects only development/CI checks; it does not involve product UI, runtime, or persistent-data migrations.

## Agent Workflow

[architecture-governance skill](../../.agents/skills/architecture-governance/SKILL.md) applies to code changes; skip it for documentation-only tasks. Before changing code, identify the expected module and check the current baseline; check again after the change. For cross-module changes, changes to state ownership, or unclear contracts, generate an `architecture:context` reading package. For local changes with clear contracts, read only the relevant contracts, specs, and tests. Specs, verification scope, and completion criteria follow the [root AGENTS.md](../../AGENTS.md); they are not defined again here.

The reading package is generated from code and policy. It includes the target module's `module.ts`, `contract.ts`, examples, contract tests, a short `CONTRACT.md`, direct dependency contracts, owner, allowed edges, and affected tests; it does not copy the full implementation.

## Rollout Order

First establish the policy, dependency graph, baseline, and report format. Then enable high-confidence structural rules. Next, use Project/Session as complete examples to validate contracts, module manifests, and reading packages. Finally, expand to areas such as workspace identity, identity, model, automation, and plugins/MCP. Do not create a separate governance gate for an individual area.

## Explicit Boundaries

Do not introduce an unvalidated general-purpose IoC/Event Center, maintain a second manually curated OWNERS dependency graph, use the feature graph as policy, or perform a one-time repository-wide migration. Code volume does not need to be balanced across layers; acceptance focuses on whether decision points, boundaries, races, and reading scope are well-contained.

## Todo103 Integration Boundaries

The policy's module directory must include `packages/provider/src` and `packages/provider-node/src`, which were extracted by the current refactor, so the checker can discover their source and generate the corresponding reading packages. Keep them registered as unmanaged, like the other existing modules in this round. Do not expand the integration into a repository-wide contract/manifest migration or refresh the baseline automatically. Zero violations under the current `managedOnly: true` setting means only that the enabled rules reported no errors; it does not prove that all existing cross-domain dependencies passed mechanical checks. Continue manual review in both directions for the Provider/Selection intersection.
