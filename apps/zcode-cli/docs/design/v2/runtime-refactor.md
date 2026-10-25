# Runtime Refactor

## Background

`packages/core/src/runtime.ts` carried session configuration, context initialization, model requests,
the tool loop, compact, rewind, event persistence and background tasks. At that size the edit
boundaries were hard to find and side effects were hard to place in the right adapter or service layer.

## Goals

- The public exports of `./runtime.js` stay stable; callers keep using `AgentRuntime` and the existing
  public types.
- `AgentRuntime` keeps only the constructor, the public API types and prototype method installation.
- Runtime internals split by cohesive capability: `context`, `model`, `turn`, `tools`, `compact`,
  `rewind`, `persistence`, `background` and pure helper modules.
- Modules interact only through the explicit runtime internal contract, never through file order or
  implicit global state.
- New or refactored files stay at or under 400 lines; a file over the threshold must be split further
  or carry an explicit follow-up split note in the same change.

## Interface contract

The public contract remains in `packages/core/src/runtime.ts`:

- `AgentRuntime`
- `AgentRuntimeConfig`
- `AgentRuntimeDeps`
- public result types for turn, resume, permission and checkpoint
- `RuntimeFactory`

The internal contract is `AgentRuntimeInternal`. It is used only inside `packages/core/src/runtime/*`
and describes runtime state fields and private collaboration methods. External packages must not import
runtime internal modules.

## Errors and side effects

- Model, file, subprocess, MCP, artifact and session store I/O still enters through the existing
  ports/adapters.
- The split does not change error types, event payloads, trace propagation, permission broker behavior
  or session persistence semantics.
- Failure paths (turn cancellation, model context exceeded, compact retry, rewind restore) keep their
  original events and log observability.

## Test coverage

- Existing runtime tests remain the behavior regression coverage.
- A runtime module boundary test ensures `runtime.ts` does not grow back into a monolith.
- Run `npm run lint` and `npm test` before finishing; if unrelated pre-existing changes cause failures,
  record the failing point and the risk.
