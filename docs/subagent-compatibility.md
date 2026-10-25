# Subagent Claude Code compatibility

## 2026-09-14 Agent listing update

The current listing contract lives in [Agent listing attachment](subagent-listing-attachment.md): the directory moved from tool description to the `agent_listing_delta` attachment (projected as MCS or user reminder by capability and position), backfilled from retained history after compact. Read-only definitions entries reserve future additions/removals; loading, override precedence, and execution snapshots keep their original contract.

> **Current state:** the runtime alias rules below still apply; UI history compatibility has moved to V4 tool row adaptation and the unified ToolCall renderer.

## Background

ZCode's subagent dispatch tool is `Agent`; the Claude Code plugin ecosystem calls it `Task`. Skills in `.claude-plugin` packages such as Superpowers directly instruct the model to call `Task`. A `SessionStart` prompt mapping alone would leave the model, hook matchers, background task recovery, and UI projection with inconsistent interpretations.

The compatibility goal is therefore a structured runtime alias for `Task`, not a per-plugin text patch. The provider-visible `tools[]` for first-party models still exposes only the canonical `Agent`; `Task` exists for historical calls, hook matchers, and internal compatibility.

## Compatibility principles

- `Agent` is the ZCode canonical subagent tool.
- `Task` is a Claude Code-compatible runtime alias delegating to the `Agent` handler; it is not in the provider-visible `tools[]` by default.
- Both share the input/output schema, permission capability, result budget, timeout, cancellation, and trace policy.
- The compatibility layer must not alter the actual tool-call trace: a model call to `Agent` keeps hook input `Agent`; a call to `Task` keeps `Task`.
- No Superpowers-specific additional context injects the tool mapping; all Claude Code plugins share the same runtime compatibility.

## Tool registration

`Task` registers as its own `ToolEntry` reusing the `agentToolEntry` handler and runtime declarations; `ToolRegistry.toContracts()` filters aliases with `providerVisible: false`. Registration boundaries match `Agent` exactly:

- The parent runtime registers the `Agent` / `Task` runtime entries only when a `subagentPort` exists.
- Without subagent capability neither runtime entry registers, so historical/internal calls cannot reach an unexecutable tool.
- The provider-visible `tools[]` contains `Agent` only, never `Task`.
- Allowlists still filter by actual tool name; an explicit allowlist without `Task` does not admit `Task`.

Core implementation:

- `apps/zcode-cli/packages/core/src/tool/handlers/agent.ts`
- `apps/zcode-cli/packages/core/src/tool/handlers/index.ts`
- `apps/zcode-cli/packages/core/src/tool/compat.ts`

## Sub-runtime recursion guard

Child agent runtimes must not recursively create subagents. Previously only `Agent` was filtered; with `Task` added, both count as the same subagent dispatch tool.

Rules:

- With `allowedTools: ["*"]`, inherit the parent tool list but filter `Agent` / `Task`.
- With `disallowedTools` present, filter the subagent dispatch tools first, then apply the disallow list.
- An explicit `allowedTools` does not extend the alias; the child runtime itself never registers `Agent` / `Task`, so a miswritten profile stays inert.
- The child runtime does not expose `EnterPlanMode` / `ExitPlanMode`: a subagent has no reliable user-approval surface, and a child entering plan mode would make `ExitPlanMode` wait on user confirmation and could hang the parent turn forever. This restriction is enforced uniformly at the child provider-visible tool list level, covering built-in `general-purpose`, `Explore`, custom profiles with `tools: ["*"]`, and explicit `tools`.

Core implementation:

- `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`
- `apps/zcode-cli/packages/core/src/tool/compat.ts`

## Hook matcher compatibility

A Claude Code plugin hook may write `matcher: "Task"` while a native ZCode call still uses `Agent`. The hook runner supports one actual `matchValue` plus a set of compatible `matchValues`:

- An `Agent` call matches `Agent` and `Task` matchers.
- A `Task` call matches `Task` and `Agent` matchers.
- The `toolName` in hook stdin always keeps the tool name that actually ran.
- Other hook events are unaffected; without an alias, single-matcher matching applies.

Core implementation:

- `apps/zcode-cli/packages/core/src/hooks/types.ts`
- `apps/zcode-cli/packages/core/src/hooks/runner.ts`
- `apps/zcode-cli/packages/core/src/tool/executor/hook-flow.ts`
- `apps/zcode-cli/packages/core/src/tool/compat.ts`

## Background tasks and permissions

`Agent` with `run_in_background` returns `async_launched`; background task tracking treats `Task` as the same subagent task:

- `Task` async launches restore their snapshot via `subagentPort.getTask`.
- `Task` does not go through normal execution background cancel; like `Agent`, its lifecycle is managed by the subagent lifecycle.
- The permission service / scheduler class `Task` as a read-only, low-risk session-scope subagent tool; the permission declaration still comes from the shared `agentToolEntry.permission`.
- `run_in_background` is a fixed capability of `Agent` / `Task`: requesting background execution returns `async_launched` directly and enters the background snapshot lifecycle; foreground execution can auto-switch into the same background path after `subagents.autoBackgroundMs` times out.

Core implementation:

- `apps/zcode-cli/packages/core/src/tool/executor/background-tasks.ts`
- `apps/zcode-cli/packages/core/src/permission/service.ts`
- `apps/zcode-cli/packages/core/src/tool/scheduler.ts`

## UI and historical data

The app/UI layer must recognize both the live `Task` and historical ZCode Agent projections:

- `packages/shared/src/tool-identity.ts` classifies `Task` into the `agent` family.
- Service and UI message normalization accept `Task` when parsing agent activity results.
- `packages/ui/src/lib/toolIdentity.ts` keeps the legacy fallback: historical `kind: "think"` + `title: "Task"` remains a legacy agent identity and must not be mis-upgraded to non-legacy just because `Task` is now a live tool name.

Core implementation:

- `packages/shared/src/tool-identity.ts`
- `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`
- `packages/ui/src/v4/toolCallRowAdapter.ts`
- `packages/ui/src/ToolCallBlocks.tsx`
- `packages/ui/src/lib/toolIdentity.ts`

## Test matrix

Key regression coverage:

- `apps/zcode-cli/packages/core/tests/tool-contracts.test.ts`: `Agent` / `Task` register only when the subagent port exists and share handler/schema/permission; provider-visible contracts contain only `Agent`.
- `apps/zcode-cli/packages/core/tests/tool-hook-context.test.ts`: `Agent` / `Task` hook matcher aliases match both ways; hook input is not rewritten.
- `apps/zcode-cli/packages/core/tests/main-tool-pool.test.ts`: the parent runtime has the `Agent` runtime capability; `Task` remains a non-provider-visible alias.
- `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`: the child runtime exposes neither `Agent` nor `Task`.
- `apps/zcode-cli/packages/core/tests/tool-executor-trace.test.ts`: Superpowers `SessionStart` no longer appends a dedicated tool mapping.
- `packages/ui/test/toolIdentity.test.ts`: live `Task` and historical `title: "Task"` legacy projections do not bleed into each other.

## Extension rules

Adding a new Claude Code tool-compatibility alias must check all of:

- Whether the tool should register as a real provider-visible tool or only a runtime alias.
- Whether the hook matcher needs the alias while hook input keeps the actual tool name.
- Whether child allowlist / disallowlist should filter recursion or dangerous capabilities.
- Whether background tasks, permission, and scheduler treat it as the same tool family.
- Whether shared/UI identity could damage historical projection data.
- Whether `docs/plugin-hooks-compat.md` and specific plugin specs need updates.
