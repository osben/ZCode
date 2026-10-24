# Stage A: Latest Staging Integration Plan

> Status: Completed 2026-08-25. Input: Provider Refactor `4e8064f8d5`, `origin/staging` `8a7eca86aa`.
>
> Full history: `git show 45f808f7:docs/working-memory/provider-refactor/plan/01-staging-integration.md`

## 1. Objective

Integrate the latest staging into Provider Refactor as the single integration baseline for later automated gates, real-artifact verification, and final wrap-up. This stage did staging semantic integration and its direct regression fixes only — no Provider design expansion, no Stage B CI gates, no real-account or production-artifact verification.

## 2. Pre-Integration Facts

- Provider Refactor had 172 unique commits versus staging's 88.
- The workspace was at a detached HEAD; the local `provider-refactor-m2` branch was held by another worktree and was not moved or overwritten.
- Two known text conflicts: `packages/services/src/zcode-agent/zcodeAgentService.ts`, `packages/ui/src/v4/SessionPane.tsx`.
- Other simultaneously modified protocol, auth, Session, Trajectory, Telemetry, and UI files required semantic review even where they auto-merged.

## 3. Invariants

After the merge these continue to hold:

1. Host-to-Worker syncs only Account Provider Config — never full Local Provider Registry sync.
2. Provider/Model static facts come only from ZCode Built-in Config, Account Provider Config, Personal Provider Config, Built-in Model Config Rules, and Personal Model Config Rules.
3. Core executes models only through ModelFactory/Model — no restored Model Connection Port, ModelRef, AI SDK execution Registry, or Runtime capability map.
4. Production code never infers reasoning, input/output format, or other static capabilities from specific modelId or Provider type.
5. Staging's product behavior, protocol evolution, and telemetry are preserved, but never by restoring retired Provider dependencies.
6. Desktop-continuous and Web-Remote-replayable message boundaries do not change because of the merge.

## 4. Known Conflict Resolution

### 4.1 `zcodeAgentService.ts`

Combined both sides' semantics: keep staging's cold-open timing and telemetry; keep Provider Refactor's `ensureAccountProviderConfigSynced`; do not restore staging's old-baseline `ensureLocalProviderRegistrySynced`. Ordering: staging cold-open timing/telemetry → conversation subscribe → `ensureAccountProviderConfigSynced` → Worker uses its own Built-in + Personal plus synced Account Config.

### 4.2 `SessionPane.tsx`

Keep staging's Platform/open telemetry behavior; keep the deletion of `modelProviderService`; the UI does not re-acquire Provider Registry or Model runtime fact ownership.

## 5. Automated Merge File Review

Auto-merged overlapping files were reviewed by domain: Protocol (strict schema, field direction, caller consistency); Auth (single Account Access and request-period credential chain); Transcript/Session (unchanged cold resume, hydration, history recovery order); Trajectory/Usage (attribution by actual execution, never reading back variable Session default selection); UI (staging's new interactions restore no old Provider Service, old DTO, or second model state); Feature Graph (deleted model abstractions are not re-registered as current production facts).

## 6. Execution and Verification Order

fetch staging → `merge --no-ff origin/staging` → resolve text conflicts + review auto-merged files → conflict-related targeted tests → old-symbol/hardcoded/Config dual-track scan → typecheck + lint + affected tests → record results and complete the merge commit. Real behavior regressions from the merge required a reproducing test before production-code changes.

## 7. Conditions for Pausing Discussion

Arbitration was required if: staging behavior demanded full Registry cross-process sync; staging introduced new static-fact sources, remote model config, or model hardcoding; the merge changed Account/Personal/Built-in Overlay order or responsibilities; staging protocol changes clashed with Active Model, request-period Access, or selection identity contracts; or a fix expanded into Remote Provisioning, ordinary Queues, or the selection lifecycle. Ordinary conflicts, test adaptation, and compatible fixes were not arbitration points.

## 8. Completion Criteria

All met: clear merge commit; both conflicts resolved by combined semantics; auto-merged files semantically reviewed; zero old Provider/Model abstractions, capability projections, or model hardcoding; conflict-related tests, typecheck, lint, and affected tests passing; results and remaining Stage B/C/D items recorded.

## 9. Implementation Results

On 2026-08-25 `origin/staging` `8a7eca86aa` was merged in. Actual text conflicts matched the pre-review (the two files above). `zcodeAgentService` kept staging's session-open timing while replacing its full Registry sync with the sole allowed cross Host/Worker boundary: the Account Provider Config ordering barrier. `SessionPane` kept Platform/session-open telemetry without restoring `modelProviderService`. Production scans found none of: `ensureLocalProviderRegistrySynced`, `ModelConnectionPort` / `ModelConnectionInfo`, `AiSdkModelRegistry`, `ZCodeModelRef`, `ModelInputMediaCapabilities` or Runtime capability maps, or strategies identifying reasoning intensity / static format capabilities by specific models.

Verification: conflict and session-open telemetry targeted tests 6 files / 73 passed; CLI Adapter/Bootstrap targeted tests 3 files / 224 passed; root `pnpm typecheck` and `pnpm lint` (0 errors) passed; root `pnpm test:unit` 1466 files / 12416 tests passed (25 skipped); `git diff --check` and `oxfmt --check` passed on related files. Repo-level `pnpm fmt:check` stays blocked by pre-existing `apps/zcode-cli/tests/gb2312.js` encoding files and vendored Electron fiddle markup; files touched by this integration passed individually, and the repo formatter baseline is not modified in Stage A (recorded as a Stage B gate baseline issue).

### Stage B Handoff Issues

The CLI sub-workspace full typecheck cannot produce valid results under the current install state: direct Adapter/Bootstrap `tsc` reads old dependency `dist` first, and under Turbo ordering `@zcode/contracts` resolves Zod v4 from the root workspace while the CLI package depends on Zod v3. The resulting Plugin/Workflow/Workspace-Hook/Tool-Display type errors are install/lock/gate problems, not Provider conflict failures. Stage A did not touch business source for this; Stage B must first restore reproducible CLI workspace install and dependency resolution before adding Core/Adapter/Bootstrap build+typecheck+test to the blocking gate.

## 10. Subsequent Staging Restoration Scope Arbitration (2026-09-06)

Standing decisions (not an open-items list):

Two staging behaviors were explicitly not restored:

1. `SessionPane` re-syncing the remote Provider Registry before sending. Sync already triggers at remote environment establishment, Provider saves, and account/credential changes; the brief delay when sending right after a save is acceptable — no new pre-send sync barrier.
2. Auto-correcting existing Sessions' Provider/Model after account connection changes. Multiple connection states may coexist; a connection change does not invalidate existing session models. No Account-first, first-model fallback, or automatic switching logic is restored.

Later wrap-up: item 1's no-pre-send-barrier boundary still stands; item 2's old event-driven bulk rewrite stays unrestored, but valid re-resolution of existing selections is uniformly implemented by Todo87/96/99 and cannot be used to reject the accounts corresponding to the new architecture. Account-first/first-model fallback must not be restored; historical `Configured Default` rollbacks are not the current contract. Save intent and effective results stay separated, committed submission boundaries stay valid, and multi-connection solutions keep only the Todo101 Draft.
