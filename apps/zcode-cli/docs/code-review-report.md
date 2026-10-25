# zcode-cli Deep Code Review — Open Findings

Deep review of all 15 packages under `/apps/zcode-cli/packages` (~96K source lines, ~49K test
lines), originally dated 2026-06-04. This file is the open-findings ledger; findings re-verified
against the current tree on 2026-10-24. Resolved findings and the original module-by-module
narrative are dropped.
Full history: `git show aac47556:apps/zcode-cli/docs/code-review-report.md`.

Target architecture direction (still valid): keep the layered
`cli -> bootstrap -> core -> contracts` Port/Adapter design, split the AgentRuntime god object
into cooperating services with explicit dependency injection, make `contracts` the single type
authority, and split subsystems (workflow, protocol server) out of their host packages.

## P0 — correctness / stability risk

### Duplicated type definitions

- `PermissionDecisionResult` is defined twice with different fields:
  `core/src/runtime/types.ts` (4 fields) and `core/src/permission/service.ts` (9 fields).
- `ToolScheduleItem` is defined twice with different fields:
  `core/src/agent/turn-state.ts` and `core/src/tool/scheduler.ts`.
- Risk: silent runtime data loss on type mismatch. Fix: define authoritative versions in
  `@zcode/contracts`, point all consumers there, delete the core duplicates.

### AgentRuntime god object

- `runtime/methods/` holds 114 method files; 67 files use the `this: AgentRuntimeInternal` mixin
  pattern and are installed onto the prototype via `proto.xxx = xxx` in `methods/index.ts`.
- The file split looks decoupled but shares all state; any method change risks shared-state
  breakage and sub-modules cannot be tested independently.
- Fix: extract collaborating services (`TurnOrchestrator`, `CompactManager`,
  `PersistenceService`, `ToolDispatcher`, `ContextManager`) with explicit dependency injection,
  keeping the `AgentRuntime` facade API stable and each phase independently revertible.

## P1 — extensibility / collaboration

- **`runtime/deps.ts` central re-export** (now 324 lines, was 209): every methods file can access
  any dependency; real dependency boundaries are invisible. Fix: import directly from
  `@zcode/contracts` per sub-module, shrink and remove deps.ts.
- **`@zcode/shared-types` overlaps `contracts`**: a 5-type package (`JsonValue`, `RunContext`,
  `GlobalLocale`, `GlobalOptions`, `RuntimeInfo`) with unclear ownership versus contracts. Fix:
  merge into contracts and delete the package.
- **`core` imports `cheerio`** (webfetch HTML parsing) — infrastructure concern leaking into the
  business layer; should sink to adapters.
- **Workflow subsystem in core** (~5.2K lines across `workflow/lifecycle.ts`, `expert/`,
  `scheduler/`) and **script-workflow in bootstrap** (10 `script-workflow-*` files in
  `bootstrap/src/app/`): independent subsystems embedded in host packages. Fix: split into
  separate packages behind ports.
- **ZCode protocol server embedded in bootstrap** (`bootstrap/src/zcode-protocol*`): split into a
  protocol-server package.
- **`adapters/model/runner-*` over-split** (now 15 files) and **auth spread over 10 files**
  without a shared `AuthProvider` contract.
- **`storage/session-store/repositories/` fragmented** (27 files); merge by aggregate root.
- **`cli` package carries 15 `tui-*.ts` files** — TUI responsibilities living in the CLI entry
  package. Move to `@zcode/tui`; `cli` stays entry orchestration only.
- **`contracts/src/interfaces/session-store.port.ts`** is now 1423 lines defining all storage
  interfaces; split by domain (message-store, session-meta, todo-store, ...).

## P2 — style / engineering hygiene

- `cli/tests/cli.unit.test.ts` is 6959 lines; split by functional domain.
- WebFetch handler is split into 11 files for ~300 lines of logic; merge into a cohesive
  `webfetch/` module.
- TUI `app-*.ts` flat naming (52 files); group into `components/`, `panels/`, `keyboard/`,
  `state/` subdirectories.
- The original review's 400-line file limit is stale: the current CLI standard is 800 lines
  (root `.oxlintrc.json` registers over-limit files as warnings; do not split files merely to
  satisfy the count).

## Engineering suggestions (still open)

- Add lint guards: forbid direct imports of core implementations from TUI; keep `tsc --noEmit`
  as a CI gate; run `knip` in CI.
- After any AgentRuntime service extraction, give each service its own unit tests and a `module`
  identifier; add call-timing metrics for the model adapter.
