# Core / Adapters Boundary

Boundary contract pulling the implementation back to the layering defined by `architecture.md`:

- `core` depends only on `contracts` and expresses business intent and state transitions.
- `adapters` depends only on `contracts` and owns external I/O: filesystem, child processes,
  network, model SDKs, storage, logging, config.
- `bootstrap` is the only composition layer, binding the ports core needs to concrete adapters.

This is not the final interface RFC. Port names here guide migration; each port's full schema,
error types, cancellation semantics and cross-platform details belong in their own RFCs.

## Dependency direction

```text
packages/contracts
  ↑
packages/core          packages/adapters
  ↑                         ↑
  └──────── packages/bootstrap ────────┘
                  ↑
          packages/cli / tui / server
```

Allowed: `core -> contracts`; `adapters -> contracts`;
`bootstrap -> contracts + core + adapters`; `cli/tui/server -> bootstrap`.

Forbidden: `core -> adapters`; `core -> fs / child_process / fetch / process.env`;
`adapters -> core`; `contracts -> core / adapters / bootstrap`.

Why the boundary matters:

- core must be independently testable, unpolluted by Node I/O, provider SDKs and platform
  differences;
- permission, audit, cancellation, retry, artifact and trace must uniformly wrap all external
  side effects;
- Windows/macOS/Linux file and subprocess differences must not scatter into business code.

## Current state

Landed (verified 2026-10-24):

- `packages/core/package.json` no longer depends on `@zcode/adapters`, and core source no longer
  references `AiSdkModelAdapter`.
- The Read / Write / Edit core handlers express tool semantics only and execute I/O through
  `FileSystemPort`; Bash goes through `ExecutionPort` (no direct `child_process` use).
- Ports exist in `packages/contracts/src/interfaces/`: `execution.port.ts`, `file-system.port.ts`,
  `context-source.port.ts`, `http-client.port.ts`, `session-store.port.ts`, `permission.port.ts`,
  `mcp.port.ts` and others; Node implementations live under `packages/adapters/src`.
- Model tool calls route back through the ZCode ToolRuntime (schedule -> permission ->
  ToolRuntime execution -> serialize results), so they cannot bypass permission, scheduling,
  audit or trace.
- File write correctness: Read records a file baseline (path, mtime/revision, hash, truncated
  read flag); Write/Edit re-read and validate before writing; atomic write handles Windows
  rename semantics; structured errors cover symlinks, case sensitivity, permission errors, BOM
  and line endings; a per-path in-process lock exists but is not treated as cross-process
  correctness.
- Architecture guard tests exist (for example `core/tests/io-boundary.test.ts`,
  `core/tests/runtime-module-boundary.test.ts`) and fail CI on new violating imports.

Known remaining gaps (verified 2026-10-24): a number of core modules still import `fs/promises`
or `node:child_process` directly, for example `subagent/runner.ts`, `runtime/methods/resume.ts`,
`runtime/methods/bash-shell-snapshot.ts`, `runtime/helpers/execution-worktree-guard.ts`,
`memory/dream-lock.ts`, `hooks/configured-runner-input.ts` and several
`tool/handlers/*` workflow/task-output helpers. Migrating them behind `FileSystemPort` /
`ExecutionPort` is the outstanding work of this plan.

## Port responsibilities

### ModelPort

Replaces any direct core dependency on the AI SDK adapter: `generateText`, `streamText`,
provider-neutral request/result/stream events, model error normalization, trace/abortSignal
propagation. Defined in `packages/contracts/src/model` / `interfaces/model.port.ts`; the AI SDK
adapter implements it; `AgentRuntimeDeps.modelAdapter` is the port type.

### FileSystemPort

Replaces `fs/promises` in core tool handlers: read text/binary, stat/exists, mkdir, atomic
write, compare-and-write / stale-write checks, path normalization, read baseline / revision /
hash. If tool implementations ever become swappable, handler registration moves to
bootstrap/adapters — Node `fs` must never re-enter core.

### ContextSourcePort

Replaces direct probing of the host process, workspace files and project structure in the
context builder: resolved `EnvInfo` (cwd, platform, shell, Node/OS versions), AGENTS.md /
CLAUDE.md user-instruction lookup, project type / package manager / build file / script
detection, and diagnostics instead of swallowed I/O errors. The core `ContextBuilder` renders a
`ContextSourceSnapshot` only; bootstrap provides `workingDirectory` and core never falls back to
`process.cwd()`.

### ExecutionPort

Replaces `child_process` in core: argv-array execution, cwd/env overlay, timeout, abortSignal,
streaming stdout/stderr events, normalized exit code/signal/timeout/cancel/spawn error, and a
sandbox policy placeholder. The Bash handler expresses intent; the Node implementation lives in
`adapters/src/exec`.

### Tool contract versus implementation

Core holds tool metadata, schema, permission, scheduler and event lifecycle; adapters register
concrete tool implementations that perform side effects only through adapter I/O ports; tool
results pass a unified serializer / artifact policy before returning to the model. The handler
type on `ToolEntry` lives in contracts or is port-based; core exports no Node built-in handler;
bootstrap assembles built-in tool implementations.

### Logger / Trace / Config

Core depends only on the `Logger`, `TraceContext` and `ConfigPort` contracts. Node logger, env
config and file config exist only in adapters; environment reads happen only in
CLI/bootstrap/adapters, never in core.

## Non-goals

This plan does not by itself: fully implement the SQLite event store, sandbox, MCP / ZCode
app-server, compact / memory / subagent; or rewrite all tool behavior — the boundary is split
first while the minimal Read / Write / Edit / Bash path stays runnable.

## Completion definition

When the remaining gaps are closed:

```sh
pnpm lint
pnpm test
pnpm --filter @zcode/core typecheck
```

all pass, and these checks return nothing:

```sh
rg "@zcode/adapters" packages/core/src packages/core/package.json
rg "fs/promises|node:fs|child_process|node:child_process|process\.env|fetch\(" packages/core/src
rg "@zcode/core" packages/adapters/src packages/adapters/package.json
```

## Migration cautions

- Split migrations by file domain; never blanket-revert or overwrite unrelated local changes.
- Shared types must enter contracts — never copy adapter types into core to cut a dependency
  quickly.
- After moving Node I/O handlers out of core, registration happens in bootstrap; core must not
  import them back directly.
