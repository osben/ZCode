# Stage A: Latest Staging Integration Plan

> Status: Completed
>
> Last updated: 2026-08-25
>
> Input: Provider Refactor `4e8064f8d5`, `origin/staging` `8a7eca86aa`

## 1. Objective

Integrate the latest staging into Provider Refactor, forming the single integration baseline used by subsequent automated gates, real artifact verification, and final wrap-up.

This stage performs only staging semantic integration and its direct regression fixes. It does not expand Provider target design, does not advance to Stage B CI gate construction, and does not enter real account or production artifact verification.

## 2. Pre-Integration Facts

- The current Provider Refactor has 172 unique commits relative to the latest staging, and staging has 88 unique commits.
- The current workspace is at a detached HEAD; the local `provider-refactor-m2` branch is occupied by another worktree. This stage does not move or overwrite the other worktree's branch references.
- Virtual merge before integration is known to have two text conflicts:
  - `packages/services/src/zcode-agent/zcodeAgentService.ts`
  - `packages/ui/src/v4/SessionPane.tsx`
- Other simultaneously modified protocol, auth, Session, Trajectory, Telemetry, and UI files need semantic review even if they merge automatically.

## 3. Invariants

After merging, the following must continue to hold:

1. Host to Worker syncs only Account Provider Config, not the full Local Provider Registry sync.
2. Provider/Model static facts come only from ZCode Built-in Config, Account Provider Config, Personal Provider Config, Built-in Model Config Rules, and Personal Model Config Rules.
3. Core executes models only through ModelFactory/Model, not by restoring Model Connection Port, ModelRef, AI SDK execution Registry, or Runtime capability map.
4. Production code must not infer reasoning, input/output format, or other model static capabilities based on specific modelId or Provider type.
5. Staging's product behavior, protocol evolution, and telemetry should be preserved, but not at the cost of restoring retired Provider dependencies.
6. The existing message boundaries between Desktop continuous and Web Remote replayable do not change due to this merge.

## 4. Known Conflict Resolution

### 4.1 `zcodeAgentService.ts`

The correct result combines both parties' effective semantics:

```text
staging cold-open timing / telemetry
                 |
                 v
conversation subscribe
                 |
                 v
ensureAccountProviderConfigSynced
                 |
                 v
Worker uses its own Built-in + Personal along with synced Account Config
```

- Preserve staging's new cold-open timing and telemetry.
- Preserve Provider Refactor's `ensureAccountProviderConfigSynced`.
- Do not restore staging's old-baseline `ensureLocalProviderRegistrySynced`.

### 4.2 `SessionPane.tsx`

- Integrate staging's new Platform/open telemetry behavior.
- Preserve the result of Provider Refactor's deletion of `modelProviderService`.
- The UI does not re-acquire Provider Registry or Model runtime fact ownership.

## 5. Automated Merge File Review

For files simultaneously modified by both sides without text conflicts, review by domain:

- Protocol: Strict schema, field direction, and whether local/remote callers are consistent.
- Auth: Account Access and request-period credential injection maintain a single chain.
- Transcript/Session: cold resume, hydration, and history recovery maintain the existing sequence.
- Trajectory/Usage: Continue to attribute Model execution based on actual execution, without reading back variable Session default selection.
- UI: Staging's new interactions do not restore old Provider Service, old DTO, or a second model state.
- Feature Graph: Do not re-register already-deleted model abstractions as current production facts.

## 6. Execution and Verification Order

```text
fetch latest staging
        |
        v
merge --no-ff origin/staging
        |
        v
Resolve text conflicts + review auto-merged files
        |
        v
Run conflict-related targeted tests first
        |
        v
Old symbols / hardcoded / Config dual-track scan
        |
        v
typecheck + lint + affected tests
        |
        v
Record results and complete merge commit
```

If the merge introduces real behavior regressions, add a test that reproduces the issue first, then modify production code.

## 7. Conditions for Pausing Discussion

Pause implementation and request arbitration if any of the following occur:

- Staging's new behavior requires restoring full Provider Registry cross-process synchronization.
- Staging introduces new model static fact sources, remote model configuration, or specific model hardcoding.
- The merge requires changing the Overlay order or responsibilities of Account, Personal, and Built-in.
- Staging's protocol changes cannot coexist with existing Active Model, request-period Access, or model selection identity contracts.
- Fixing requires expanding to Remote Provisioning, normal Queues, or model selection lifecycle.

Ordinary code conflicts, test adaptation, and compatible fixes that do not change the existing design do not constitute manual arbitration points.

## 8. Completion Criteria

- The latest staging has formed a clear merge commit.
- Both known conflicts are resolved by combining semantics per this plan.
- Auto-merged overlapping files have completed semantic review.
- Old Provider/Model abstractions, capability projections, and specific model hardcoding remain at zero.
- Conflict-related tests, typecheck, lint, and affected tests pass.
- Stage execution results, items still belonging to Stage B/C/D, and any existing baseline failures have been recorded.

## 9. Implementation Results

On 2026-08-25, `origin/staging` `8a7eca86aa` was merged into Provider Refactor. Actual text conflicts matched the pre-review, with only:

- `packages/services/src/zcode-agent/zcodeAgentService.ts`
- `packages/ui/src/v4/SessionPane.tsx`

`zcodeAgentService` preserves staging's session open timing while replacing its old full Provider Registry sync with the sole allowed cross Host/Worker boundary Account Provider Config ordering barrier. `SessionPane` preserves staging's Platform/session-open telemetry without restoring the retired `modelProviderService`.

Auto-merged overlapping files have been reviewed by Protocol, Auth, Transcript, Trajectory, UI, and Feature Graph groupings. Production code scanning did not reappear:

- `ensureLocalProviderRegistrySynced`
- `ModelConnectionPort` / `ModelConnectionInfo`
- `AiSdkModelRegistry`
- `ZCodeModelRef`
- `ModelInputMediaCapabilities` or Runtime capability map
- Execution strategies that identify reasoning intensity or static format capabilities by specific models

This integration verification results:

- Conflict and session-open telemetry targeted tests: 6 files, 73 passed.
- CLI Adapter/Bootstrap overlapping file targeted tests: 3 files, 224 passed.
- Root `pnpm typecheck` passed.
- Root `pnpm lint` passed, 0 errors; existing warnings are not handled as new errors for this integration.
- Root `pnpm test:unit`: 1466 files passed, 1 skipped; 12416 tests passed, 25 skipped.
- `git diff --check` and `oxfmt --check` on related files passed; formatting of staging's new OpenAPI files simultaneously.

The repo-level `pnpm fmt:check` is still blocked by existing `apps/zcode-cli/tests/gb2312.js` encoding files and vendored Electron fiddle HTML illegal markup. Files newly added, conflict-resolved, and directly adjusted in this integration have individually passed format checks; the full repository formatter baseline is not modified via third-party fixture fallbacks in Stage A, and continues to be recorded as a gate baseline issue for Stage B.

### Stage B Handoff Issues

The full typecheck of the CLI sub-workspace cannot form valid results under the current install state. Running Adapter/Bootstrap `tsc` directly reads old dependency `dist` first; when building by Turbo dependency order, `@zcode/contracts` resolves to Zod v4 from the root workspace, while this CLI package declares and depends on Zod v3. The resulting Plugin, Workflow, Workspace Hook, and Tool Display type errors are not failures of the Provider conflict path, but direct evidence that the CLI sub-workspace install/lock/gate is not closed.

This issue is not addressed by modifying business source code in Stage A. Stage B must first restore reproducible CLI workspace install and dependency resolution, then incorporate Core, Adapter, Bootstrap build/typecheck/test into the automated blocking gate.

## 10. Subsequent Staging Restoration Scope Arbitration (2026-09-06)

These are the arbitrations as of 2026-09-06; not the current outstanding list. Subsequent substitution relationships are at the end of this section.

Two groups of staging behaviors were explicitly not restored:

1. `SessionPane` synchronizes the remote Provider Registry again before sending. Current sync already triggers at remote environment establishment, Provider save, and account/credential changes; the brief delay when sending immediately after save is acceptable behavior, no new pre-send sync barrier is added.
2. Automatically correcting existing Session's Provider/Model after account connection changes. Multiple connection states may be retained simultaneously in the future; connection changes do not mean existing session models are invalid; no Account-first, first-model fallback, or automatic switching logic is restored.

Subsequent wrap-up: The first item's pre-send barrier non-restoration boundary remains preserved; the second item's old event-driven bulk rewrite was not restored, but the valid parsing of existing selections has been uniformly implemented by Todo87/96/99, and cannot be used to reject accounts corresponding to the new architecture. Account-first or first-model fallback must not be restored; nor can historical `Configured Default` rollbacks serve as the current contract. Save intent and effective results are separated, and committed submission boundaries remain valid, with multi-connection solutions retaining only Todo101 Draft.
