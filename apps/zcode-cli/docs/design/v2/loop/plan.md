# Core Implementation Plan (shipped)

This was the M1-M5 plan for the minimal agent loop core: turn state machine plus event-driven
state transitions. All milestones landed; this file keeps the durable rules and the still-open
questions. See `architecture.md` and `interfaces.md` for the current contracts.

## Minimal CLI entry

The thinnest headless entry is `zcode --prompt "<text>"`, with a fixed call chain:

```text
packages/cli
  -> packages/bootstrap
  -> AgentRuntime.executeTurn()
```

`executeTurn()` is core's application/runtime layer: the business orchestration entry for one user
turn, advancing session events, turn state, context builder, model requests, and the tool loop.
CLI/TUI/SDK never assemble context, execute tools, or call providers directly; they only hand user
input to the runtime assembled by bootstrap. The `--prompt` entry stays unchanged as later context
builder, model adapter, and tool executor integrations land.

## Milestones (delivered)

- M1 Basic data structures — `packages/contracts/src/interfaces/session.port.ts`
  (`SessionEventStorePort`, `EventReducerPort`), `events/session.events.ts` (`SessionEvent`),
  `errors/index.ts` (`CoreError`).
- M2 Events and EventReducer — append-only event log and projection updates; reducer unit tests and
  event immutability tests.
- M3 Turn state machine — `packages/core/src/agent/turn-state.ts`, `turn-machine.ts`;
  legal/illegal transition tests; session create/resume tests.
- M4 Tool Scheduler — `packages/core/src/tool/scheduler.ts`; topological sort, parallel grouping,
  cycle detection tests.
- M5 Agent Runtime skeleton — `packages/core/src/runtime.ts` plus
  `permission/service.ts`; simulated turn flow and hook point tests.

## Test strategy

- Integration: `AgentRuntime` end-to-end over a full turn, mocking `ProviderAdapter`,
  `ToolRuntime`, and storage.
- Unit: `EventReducer` / `TurnMachine` / `ToolScheduler` as pure functions with no external
  dependencies.
- Types: TypeScript correctness via type snapshots.
- Mocks are hand-written implementations of the contract ports (for example an in-memory
  `SessionEventStore`); framework is Vitest.

Verification per milestone: `pnpm typecheck` and `pnpm test` pass, key paths have unit coverage,
and the code is explainable to others.

## Open questions

- [ ] ToolScheduler dependency-detection algorithm details (runtime still passes empty `dependsOn`;
  see `output-state-rotation.md`).
- [ ] AgentRuntime public API design evolution.
