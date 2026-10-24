# Expert Workflow Runtime Split

## Purpose

`packages/core/src/workflow/expert.ts` is the public entry of the expert workflow but must not keep carrying all responsibilities. This split only adjusts internal module boundaries; it does not change workflow behavior, the store contract, event payloads, graph record shape, artifact paths or public exports.

## Boundaries

- `expert.ts` keeps a compatibility facade and keeps exporting `ExpertWorkflowRuntime`, `WorkflowRuntime`, `formatExpertWorkflowStatus`, `DEFAULT_EXPERT_WORKFLOW_STRATEGY` and `createExpertWorkflowDefinition`.
- The Runtime public API owns only the command entry and runtime orchestration, and does not parse model JSON directly.
- The Parser only normalizes model text into workflow contract data; it does not write the store, emit events or modify the snapshot.
- The prompt/formatter/report builder only produces text; it does not read adapters and does not write artifacts.
- The snapshot helper does only immutable state transformations; store writes and graph record/event emission are centralized in the runtime service.
- The phase runner owns only the state, artifacts and session links of an ordinary agent phase.
- The scheduled phase bridge only connects `WorkflowGraphScheduler` to the agent runner/store and must not modify the scheduler contract.
- The critic loop owns only the final critic verdict, node reopen and rerun decisions, and does not parse loose JSON directly.
- All async execution must keep propagating `AbortSignal` and `TraceContext`.

## Invariants

- The built-in expert workflow phase order, default strategy and default artifact paths are unchanged.
- `sessionLinks` is still derived from activities by `deriveWorkflowSessionLinks`.
- The graph record payloads such as `graph_seeded`, `node_prompts_updated`, `reopen_node` and `update_status` stay compatible with the old version.
- Workflow events such as `run_started`, `phase_started`, `workflow_session_linked`, `artifact_written`, `phase_completed`, `critic_*`, `run_completed` and `workflow_paused` keep their semantics.
- `startBackground` still returns a backgrounded run snapshot and manages later cancellation through an internal abort registry.
- The parser must keep legacy/loose field compatibility, for example `node_name`, `reopen_proposals`, `collection_node_ids`, `nodePrompts`, fenced JSON.

## Verification

- `pnpm --filter @zcode/core test -- tests/expert-workflow.test.ts tests/workflow-lifecycle.test.ts`
- `pnpm --filter @zcode/core typecheck`
- `npm run lint:count`
- `npm run lint`
- `npm test`
