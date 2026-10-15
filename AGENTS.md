# Core Principles

- Before adding or changing behavior, first update the corresponding spec; create the directory as needed if it does not exist. First clarify product rules, state owners, interfaces, and acceptance scenarios, then implement the code.
- Treat the currently checked-out source, `package.json`, and the architecture policy as the source of truth. Instructions should only retain features, commands, and files that the current repository provides; when removing a feature, clean up references in instructions and skills at the same time.
- When locating a problem, if code changes are not explicitly requested, investigate the cause first. Combine source code, logs, and runtime evidence to distinguish confirmed causes from hypotheses pending verification.
- Preserve local changes unrelated to the task; do not restore removed modules or internal dependencies on your own.

## Commands and Repository Structure

Before starting work, run `node scripts/check-workspace-freshness.mjs` to check the baseline. The Node version is defined by `mise.toml`.

Run the following commands from the repository root:

| Purpose                     | Command                                              |
| --------------------------- | ---------------------------------------------------- |
| Type check                  | `pnpm typecheck`                                     |
| Lint                        | `pnpm lint` / `pnpm lint:fix`                        |
| Format check                | `pnpm fmt:check`                                     |
| Desktop development         | `pnpm dev:desktop`                                   |
| Web development             | `pnpm dev:web`                                       |
| Pre-commit check            | `pnpm verify:pre-push` (Lint and architecture check) |
| Architecture check          | `pnpm architecture:check --changed`                  |
| Module reading package      | `pnpm architecture:context <module-id>`              |
| Unused dependencies/exports | `pnpm knip`                                          |
| Export reference lookup     | `pnpm dep:refs --list-exports <file>`                |

Test entry points are defined by the target package's current `package.json` and actual test files; do not assume a unified unit test or E2E command exists.

- `packages/desktop`: Electron main, host, renderer.
- `packages/web`, `packages/server`: Web client and server.
- `packages/ui`: Shared React components, hooks, and Zustand store.
- `packages/services`: Business services; `packages/rpc`: RPC framework.
- `packages/shared`: Shared protocol and types; `packages/client`: Agent client SDK.
- `apps/zcode-cli`: Agent CLI and runtime.
- `CONTEXT.md`: Plugin store domain vocabulary; read before modifying related UI.
- `DESIGN.md`: UI design guidelines; read before modifying UI.

## Implementation and Verification

- For code changes, use `.agents/skills/architecture-governance/SKILL.md`: run the architecture check first, then read the controlled context of the target module.
- Avoid duplicated state and multiple write paths. Define a single owner, interface, dependency direction, event order, and idempotency boundary; do not use timeouts to mask synchronization problems.
- When there are behavior changes, add the corresponding tests first; interaction changes require E2E scenarios. Check that tests are consistent with the implementation, and actually run the available verification. If not run or the environment is limited, state so truthfully.
- When fixing a bug, use English comments only, and add them only when they explain the cause or prevention constraints. When a design flaw is found, align with the user first instead of continually adding fallback branches.
- For solutions involving state, timing, remote, or asynchronous synchronization, use a diagram to show owners and event order.
- You must run `pnpm typecheck` and `pnpm lint` and report the real results; do not report pre-existing failures as passing.
- Use asynchronous file and network IO; cross-package imports use public entry points and follow existing path aliases.
- Forbidden: UI directly calling a Repo, a Service referencing a concrete Runtime implementation, cross-domain imports of implementation details, and circular dependencies.

## UI and Platform Boundaries

- Follow `DESIGN.md`, reuse existing components, and account for layout, interaction, theme, and internationalization on both desktop and mobile Web.
- Components access services through `packages/ui/src/hooks/`; platform operations go through `IPlatformService` (`packages/shared/src/platform.ts`), never by calling `window.zcode` directly.
- Handle differences between Desktop, Web, local, and remote environments via dependency injection, and account for Windows, macOS, and Linux.
- Zustand state lives in `packages/ui/src/store/`. Broadcast-synced fields such as theme and language must be protected against loopback; UI-local state must not be mistaken for server-side facts.
- Files in hooks that contain JSX use `.tsx`.

## Processes, Protocol, and Remote Control

- The Desktop app communicates with the Agent over stdio. Protocol changes must update `packages/shared/src/zcode-protocol/index.ts` at the same time, providing strict types and runtime validation.
- Main is responsible for windows, native operations, process scheduling, and message forwarding; it does not hold task/session business state.
- Each window uses one window-scoped Local Host; local workspaces share that Host. Remote workspaces are managed by the in-window connection registry; do not create a separate Desktop Remote Host.
- Mobile remote control connects to the desktop's existing Host attachment and reuses the session runtime; do not spin up a separate Agent, Local Host, or remote session for mobile.
- The Desktop `desktop-continuous` real-time link and the mobile `web-remote-replayable` recovery link must be clearly distinguished. When modifying stream, snapshot, queue, or reconnection, verify both semantics.
- The external relay and Main only handle authentication, pairing, heartbeat, forwarding, and attachment scheduling; they do not store business state such as task queues or snapshots.
- Accepted busy/running input is serially admitted by the CLI/runtime `CommandInbox`; the Renderer only keeps uncommitted drafts and the pending optimistic overlay, and Host owner/lease is responsible for routing.
- Preserve owner/lease, cross-Host routing, and stale run protection; do not remove boundary checks based on a single path alone.

## Shared Databases and Fork Divergence

- The upstream app and this fork share the same user data: `~/.zcode/v2/tasks-index.sqlite` and `~/.zcode/cli/db/db.sqlite`. Both use per-id checksum ledgers (for example `tasks_schema_migration`); each build applies only its own migration definitions and ignores unknown ledger rows, so additive migrations from either side coexist.
- Never modify upstream migration definitions or anything feeding their checksums: migration ids and order, schema DDL strings, frozen column declarations, migration SQL — including comments inside those strings. A changed checksum makes the other build reject the shared database.
- Fork-owned tables and columns must use a `fork_` name prefix so a future upstream table can never collide with them.
- Fork migrations use non-colliding ids (`9001_fork_*`), are additive only, and never take numbers in the upstream `000N` sequence.
- `setting.json` is not fork-safe storage: settings writes re-parse through the app settings schema, which strips keys unknown to the writing build (an upstream release would delete fork keys, and an older fork build would delete newer upstream keys). Fork-only state lives in `fork_`-prefixed storage (a fork DB table or a sidecar file), never as new `setting.json` keys.

## Workspace Identity

- `workspaceIdentity` is used for identity isolation; `workspacePath` is used for file operations, command cwd, Git, and path display.
- The identity key is uniformly `workspaceIdentity?.trim() || workspacePath`, applying to deduplication, binding, caching, queues, persistence, and request correlation.
- Remote links pass `workspaceIdentity` and `remoteSessionId` end to end; never match by path alone.
- New interfaces keep a local path fallback; remote identity reuses existing construction and parsing utilities; do not hand-write the format in business code.

## Logging

- UI uses `packages/ui/src/logger.ts`; do not use `console.log` or `window.zcode?.log` directly.
- Agent/session/runtime-related service logs use `createServiceLogger(scope)` (`packages/services/src/logger/serviceLogger.ts`).
- `debug` is for high-frequency diagnostics such as raw protocol data, streaming chunks, and per-item tool updates; not persisted to disk in production.
- `info` is for production-usable events such as process and session lifecycle, permission results, and one-time initialization.
- `warn` is for recoverable exceptions; `error` is for unrecoverable errors such as crashes, handshake failures, and lost authentication.
- Do not write credentials, real user data, or internal service addresses in logs, examples, or commits.
