# Agent Instructions

This is a TypeScript Node.js coding-agent CLI that supports mainstream models and operating systems. Follow the general task boundaries, spec, verification, and commit requirements in the [root AGENTS.md](../../AGENTS.md); this file adds CLI-specific rules. Use the Node.js version specified by the repository [mise.toml](../../mise.toml).

## Working Rules (Highest Priority)

- CLI specs are in `apps/zcode-cli/docs/design/v2/`. Update them before new features and behavior changes; for bug fixes and pure refactors, follow the root rules. Code and documentation paths below are relative to this directory unless prefixed with `apps/zcode-cli/`.
- Before changing any tool (adding, removing, or changing its schema, permissions, execution, prompt, adapter, event, or UI/V4 projection), read and update `docs/design/v2/tool/00-tool-change-chain.md` and check the end-to-end flow.
- Tests are essential and should demonstrate whether the result meets expectations.
- Update feature documentation to describe final behavior, reusing existing specs. For bug fixes, retain regression evidence and add Chinese comments at the fix site for non-obvious root causes and prevention constraints.
- Make the project agent-friendly by providing logs or interfaces that let an agent take over the work.
- Prioritize long-running tasks: the core agent loop is designed by default for complex tasks that can run continuously and does not impose a hard stop based on tool-call count. Token/context limits with automatic compaction, user cancellation, permission denial, tool timeouts, output truncation, and provider retry limits provide explicit resource and safety boundaries.
- A source file should generally stay under 400 lines. If it exceeds that limit, first split it into cohesive, loosely coupled modules instead of continuing to accumulate responsibilities in a large file.
- Extract string and numeric constants into named variables or constants rather than scattering literals through business logic, so they can be changed in one place and maintained consistently.
- When changing the database schema, coordinate with the CLI owner and carefully design the migration.
- Prefer keyboard operation; core functionality should be accessible through the keyboard. Mouse operation is an enhancement.

## Tooling Rules

- Consider Windows, macOS, and Linux before interacting with the operating system.
- Keep the standard Node.js CLI packaging method as the default release path.
- Prefix project-owned environment variables with `ZCODE_`, but do not add variables casually. Before adding one, define its purpose, precedence, error behavior, and test coverage in a spec under `docs/design/v2`. Prefer configuration files, CLI arguments, or session configuration when they can express the capability.

## Cross-Platform Compatibility

- Design all features by default for Windows, macOS, and Linux; do not implement behavior based only on the current development machine.
- Prefer cross-platform Node.js standard-library APIs such as `path`, `url`, and `fs` for path handling. Do not hard-code path separators, absolute-path prefixes, line endings, or temporary-directory locations.
- Prefer argument arrays with `child_process.spawn` / `execFile` to run external commands. Avoid shell-string concatenation and dependencies on POSIX-only syntax, pipes, redirection, or built-in commands.
- When invoking system commands, editors, shells, package managers, or executables, account for Windows `.cmd` / `.exe` files, paths with spaces, argument escaping, environment-variable casing, and shell differences.
- Filesystem logic must account for differences in case sensitivity, permission models, symbolic-link support, executable-bit support, line endings, and path-length limits.
- Base terminal interaction on capability detection rather than fixed assumptions. Colors, TTY, Unicode, interactive input, window size, and signal handling need a fallback for non-interactive or limited environments.
- Resolve user, cache, configuration, temporary, and project directories with explicit cross-platform logic; do not hard-code Unix-style directory layouts.
- Add or update tests for cross-platform differences when introducing system-interaction capabilities. State any behavior that cannot be verified on the current system and the remaining risk in the implementation and documentation.

## Module Boundaries and Interface Contracts

- Interactions between modules must use explicit, limited, stable interfaces.
- Each module should be independently understandable, testable, and replaceable, and expose strict type declarations, interface definitions, or schema declarations.
- Modules must coordinate through standardized contracts rather than depending directly on one another's implementations. Callers must not depend on a callee's internal implementation, directory structure, implicit global state, or undeclared conventions.
- Public module contracts should clearly describe capabilities, inputs, outputs, error shapes, state changes, and side effects.
- When data crosses a process, storage, network, plugin, tool-call, or LLM boundary, prefer schemas that can be validated at runtime over TypeScript types alone.
- Define interface contracts before implementing new interactions between modules.

## Converge External I/O at Boundaries

- All external side effects must be observable, approvable, cancellable, retryable, queueable, auditable, and testable through a unified mechanism. Business logic expresses intent; it does not touch the external world directly.
- Route all external I/O through a clear infrastructure layer or adapter, including network requests, filesystem access, child-process calls, environment-variable reads, terminal input/output, caches, databases, the system clipboard, and external services.
- Outside entry points, infrastructure layers, and adapters, business modules must not call low-level I/O APIs such as `fetch`, `http`, `fs`, `child_process`, or `process.env` directly. They should depend on interfaces, services, or adapters defined by the project.
- I/O adapters must expose stable type declarations or schemas that define inputs, outputs, error types, timeout, cancellation, retry semantics, idempotency, and side-effect scope.
- Route network access through a unified request entry point to centralize timeouts, retries, backoff, authentication, proxies, custom certificates, rate limits, logging, auditing, and error normalization.
- Route file access through a unified filesystem entry point to centralize atomic writes, concurrency control, temporary files, queued writes, permission errors, path normalization, and platform differences.
- Route child-process execution through a unified execution entry point to centralize sandboxing, permission approval, environment variables, timeouts, cancellation, output truncation, streaming output, and exit-code normalization.
- Handle asynchronous execution, queuing, retries, degradation, or auditing at the I/O boundary when required; do not scatter those mechanisms through business logic.

## Tool and Side-Effect Contracts

- Each tool should declare its `inputSchema`, `outputSchema`, whether it is read-only or destructive, whether it is safe to run concurrently, maximum output size, timeout, cancellation semantics, and permission requirements.
- Tools must explicitly declare their side-effect scope, such as `none`, `workspace`, `git`, `network`, or `system`. Permission systems, sandboxes, and approval flows should read these declarations rather than infer behavior at the call site.
- Tools with side effects should declare idempotency and recovery strategies where practical, to support retries, rollback, queued execution, and failure recovery.
- Do not feed large tool results directly back into model context. Store them in an artifact/storage layer and return only a summary, preview, and traceable reference.
- External extensions such as MCP, plugins, and subagents must be integrated through capability declarations, schema validation, namespace isolation, and centralized permissions. They must not receive direct access to internal module implementations.

## Sessions, Configuration, and Observability

- A coding-agent CLI should treat sessions, messages, tool calls, permissions, checkpoints, queues, and pending states as first-class state objects, with support for recovery, branching, rollback, and concurrent sessions.
- The TUI handles input collection, layout rendering, and temporary interaction state such as the cursor, input box, scroll position, and current dialog selection. Business state such as session, mode, model, tool, todo, permission, and checkpoint must not live in the TUI layer. Store it in server/bootstrap/core/session and deliver it through explicit interfaces or session events.
- Use `+` and `-` consistently for collapsed/expanded indicators in the TUI (`+` for collapsed, `-` for expanded); do not use `v` or `>`.
- Design confirmations, selections, input, progress, error recovery, and other user interactions as stable interaction request/response interfaces or session events for both the TUI and ZCode Protocol V4 clients. Clients are presentation and transport adapters; do not hard-code interaction flows in one frontend.
- Every task execution must carry a propagatable `traceId`. By default, `traceId` represents the full task chain of a top-level session. Child sessions, subagents, retries, background queue tasks, and asynchronous I/O created within the session must use the same `traceId`.
- `traceId` sits above `sessionId`. Use `sessionId`, `turnId`, `messageId`, `toolCallId`, `spanId`, and `parentSpanId` as structured child identifiers under `traceId` to reconstruct the full call chain.
- Every module, service, adapter, tool runtime, provider client, I/O adapter, and permission decision must receive and continue propagating the shared execution context. Do not drop or overwrite it, or create an unrelated `traceId` mid-flow.
- Avoid introducing asynchronous tasks, tool calls, external I/O, cross-module calls, or child sessions that cannot be associated with a `traceId`; they are unobservable behavior.
- Integrate providers, models, MCP, storage, network proxies, and certificates through adapters. Do not hard-code a specific vendor, transport protocol, or deployment environment in session-core.
- Configuration must have clear layers and precedence, such as system, user, project, session, CLI arguments, and environment variables. Security-related configuration must retain source information.
- Follow the `.agents Protocol` and `AGENTS.md` conventions. Future designs, especially configuration discovery, reading, and precedence resolution, should be compatible with the `.agents Protocol` by default.
- Include debugging and observability entry points from the first version, covering model requests, context composition, tokens/cost, tool calls, I/O, permission decisions, retries, queue buildup, and dropped queue items.
- Logs, traces, and debug output must not expose keys, tokens, private data, or complete user content. Highly sensitive information must use an explicitly controlled debug path.

## Error Handling First

- Treat errors as first-class design objects. When adding a feature, first consider failure paths, error ownership, propagation, and the final user-facing message.
- Let errors bubble up by default until they reach a layer that can handle them. Do not casually swallow errors in low-level modules, log and continue, or prematurely convert errors to plain strings.
- Catch errors only when the code can recover, retry, degrade, add context, turn them into actionable user guidance, or is at a CLI entry boundary.
- When throwing or wrapping an error, preserve the original cause and add necessary context so the call chain and system error details are not lost.
- Make deep system state visible to users: propagate errors, waiting, retries, permissions, model, tool, and I/O state through the call chain to interfaces such as the CLI/TUI, while keeping keys, private data, and complete raw content out of view.
- Low-level business modules must not call `process.exit`, print errors directly to the terminal, or decide the final exit code. The CLI entry layer formats errors, prints guidance, and sets the exit code consistently.
- Do not use error text to control program flow. Use stable error types, error codes, or structured fields when distinguishing errors.
- Tests should cover critical failure paths, especially common CLI errors such as missing configuration, insufficient permissions, network failures, filesystem errors, invalid user input, and failed external commands.

## Commit Conventions

- Create one separate commit for each feature-level change.
- Do not mix unrelated features, refactors, dependency updates, or formatting changes in one commit.
- Keep commits small enough to review independently.
- When a feature change spans multiple files, include those files together.
- If a task requires multiple feature-level changes, split them into separate commits in review order.

## Verification

- Before completing code changes, run `pnpm typecheck` and `pnpm lint` from the repository root. For CLI changes, also run `pnpm --dir apps/zcode-cli typecheck` and `pnpm --dir apps/zcode-cli lint`.
- Determine test entry points from the target package's current `package.json` and actual test files; do not assume a unified test command exists. Run the relevant tests for behavior changes and cover E2E scenarios for interaction changes.
- Accurately report commands run, results, and unverified areas. Do not claim checks passed when test entry points are missing, existing failures remain, or the environment prevented verification.
