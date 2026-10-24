# Expert Workflow TODO

## Purpose

Handoff TODO for taking `/expert` from the v0 workflow shell to a GSAP-class scheduler.

Current state: `/expert` exists and defaults to yolo; runs persist under `~/.zcode/cli/workflows`;
ZCode app-server exposes `start/list/get/cancel` plus workflow event notifications; z-code-2 has a
Workflows side pane; the runtime executes non-exec expert phases serially and routes `exec` through
the generic workflow DAG scheduler.

Target state: `exec` is a real DAG scheduler; the graph grows and changes during execution; child
agent sessions are first-class node activities; ZCode app-server streams fine-grained scheduler
state so z-code-2 can debug what is running, ready, blocked, retried, reopened, or done.

## P0: Real DAG executor — done

The generic scheduler derives ready/active/blocked nodes, dispatches ready executable nodes with
`maxConcurrentLoops`, records child agent activities per node, emits node/frontier/executor events,
retries failed nodes, pauses on `maxConsecutiveErrors`, and exposes derived scheduler state through
the workflow contract plus ZCode app-server detail responses. The durable contract exposes generic
`WorkflowRunSnapshot` / `WorkflowStrategy` names with expert compatibility aliases. Resume/cancel
have generic snapshot repair: stale active work is closed before resume, cancellation marks
non-terminal state cancelled, and same-process background runs receive abort signals. Remaining P0
work: feed richer task graphs from planner output.

Delivered: executor module in `packages/core/src/workflow/`; graph-derived ready nodes; node states
`pending`/`active`/`completed`/`failed`/`skipped`/`cancelled`; ready nodes dispatched as child agent
session activities; strategy fields `executor.maxConcurrentLoops` and
`executor.maxConsecutiveErrors` respected (`reactLoop.maxRounds` is included in node prompts;
per-node loop enforcement stays in the child AgentRuntime/react-loop policy); state persisted after
every node transition; events `node_started`, `node_completed`, `node_failed`, `frontier_changed`,
`executor_paused`, `executor_completed`; all external I/O behind the workflow store and agent
runner ports.

Acceptance (met): independent nodes run concurrently; dependency-blocked nodes stay blocked;
failed nodes retry or reset per error policy; `zcode.dev/workflow/get` returns a graph where
z-code-2 shows active/ready/blocked correctly. Tests cover ready-node derivation, dependency
blocking, concurrency cap, error threshold, and child session activity recording.

## P0.5: GSAP-like node executor — open

Goal: built-in expert task nodes execute like `zcode-cli-bak/src/gsap` — subplan the node, run
actor/critic loops, expose every sub-activity through ZCode app-server. The generic DAG scheduler
stays the owner of ready/blocked/frontier state; phase nodes may keep the direct activity path.

Tasks:

- Extend workflow activity kinds for subplanner, actor, and critic child sessions.
- Add scheduler callbacks so a node executor records nested activities and artifacts without owning
  scheduler state.
- Implement expert task node execution: subplanner JSON parser with legacy GSAP aliases; actor JSON
  parser with tolerant fallback for Markdown summaries; critic JSON parser with pass/fail verdict
  and blockers; retry actor rounds with critic feedback up to `reactLoop.maxRounds`.
- Keep ZCode app-server aligned: nested activities in `snapshot.activities` and
  `snapshot.sessionLinks`; `workflow_session_linked` with `nodeId`, `activityId`, `activityKind`,
  `loopId`, `sessionId`, `model`; `zcode.dev/workflow/get.scheduler.activeActivities` derivable from
  the snapshot.
- Worktree isolation and merge locking come after the activity/ZCode app-server contract stabilizes.

Acceptance: a seeded expert exec node creates subplanner/actor/critic activities besides the parent
node activity; workflow get shows child session links per nested attempt; a critic failure causes
another actor round with the prior feedback; a blocked or exhausted loop fails the node through the
existing pause/retry policy. Tests: scheduler nested activity recording and session link
derivation; subplanner -> actor -> critic pass; critic fail then pass on round two; workflow/get
returns nested session links and activity kinds.

## P1: Exploration planner — done

Generic collection/frontier state, graph expansion validation, planner activity recording, and
scheduler planner hooks are in place at the workflow layer. The runtime accepts a generic
`WorkflowGraphSeed` from planning artifacts and seeds `exec` task nodes and collections after expert
`arch_decompose`; the parser accepts the legacy GSAP architecture graph shape (`name`, `references`,
`source`/`target`, `node_names`/`nodeNames`) from `~/workspace/zcode-cli-bak`. `meta_prompt` can
return a `WorkflowNodePromptUpdateSet` updating existing target-phase nodes before dispatch.

Delivered: optional graph collections (`collectionId`, `nodeIds`, `explorable`, `frontierTarget`,
`plannerRuns`, `exhausted`); planner activity type; planner port runs when a collection frontier
falls below target; planner appends nodes/edges through generic validation; planner watermarks
avoid re-analyzing completed nodes; events `planner_started`, `planner_completed`, `planner_failed`,
`graph_expanded`, `collection_exhausted`; artifact parser turning `arch_decompose` output into exec
task nodes/edges/collections.

Acceptance (met): a graph grows during `exec`; the scheduler sees newly added ready nodes without
restart; planner run count and exhausted state survive resume; z-code-2 can show
collection/frontier status. Remaining: runtime coverage for richer `meta_prompt` prompt enrichment
once wired.

## P2: Final critic reopen loop — done

Implemented as a generic workflow critic result schema plus a reusable reopen-node snapshot
operation. Expert `final_critic` parses critic JSON, emits critic lifecycle events, reopens eligible
completed/failed/skipped nodes with a cap, and re-enters the generic scheduler for reopened work.
Empty fail-without-reopen exits safely. Delivered: critic output schema (verdict, reopened node ids,
reason per node, optional acceptance gaps); `reopen_node` graph operation; reopen proposals reset
nodes to `pending` and re-enter the executor; per-node reopen cap; events `critic_started`,
`critic_passed`, `critic_failed`, `node_reopened`, `critic_iteration_limit_reached`.

Acceptance (met, tested): critic pass completes the workflow; fail with one reopen reruns that node
with dependency rules intact; loops stop at `finalCritic.maxIterations`; fail with no reopen exits
safely; the reopen cap is enforced.

## P3: Resume, cancel, and recovery semantics — partially done

Done: `active` nodes reset to `pending` on resume unless the child session is known to still run;
cooperative cancellation at run level; graph/state reconciliation before resume. Resume/cancel
repair lives at the generic workflow snapshot boundary.

Open:

- Persist enough activity state to reconnect child sessions (the runtime does not yet reconnect to
  still-running child sessions, so resumed active work is conservatively retried).
- Detect corrupt or incompatible workflow artifacts and surface structured errors.
- Add a workflow lock so two processes cannot mutate one run at the same time.
- Node-level and planner-level stop: currently represented only by graph/activity cancellation
  state; planner activities themselves are future P1/P3 work.

Acceptance: killing the process during `exec` allows safe resume; cancelling stops new dispatch and
marks active work cancelled or pending with a reason; corrupt state produces a user-actionable
error, not silent data loss. Tests: resume after active node reset, cancel active run, refuse or
repair malformed state, concurrent mutation lock.

## P4: ZCode app-server state surface — mostly done

Done in the protocol layer: workflow detail responses with active child session ids; fine-grained
events on `zcode.dev/workflow/event`; events stay small (large artifacts return paths/references);
tests for workflow start/get/notification and structured invalid-request errors. Graph nodes/edges,
active/ready/blocked node ids with blocking dependency ids, collection/frontier state, and recent
scheduler events are available through the derived scheduler object (see `expert-workflow.md`).

Open app follow-up: the current z-code app no longer has the ZCode Protocol handler.
`packages/shared/src/zcode-task-types.ts` already models `ZCodeWorkflowEventRecord.nodeId` and
`payload`, but `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts` still leaves workflow
methods empty/unsupported. Reconnect workflow transport through `IZCodeTaskService` before
productizing the debugger: route workflow list/get/start/cancel/retry to the ZCode agent server and
publish `workspace_workflow_event` through dynamic workspace events; keep `ZCodeWorkflowKind` a
non-empty string so custom definition-backed workflows stay observable.

## P5: z-code-2 debugger polish — open

Tasks in `/Users/dev/workspace/z-code-2`: graph filters (all, active, ready, blocked, failed);
activity/session rows linked to the corresponding task/session view; node-level event timeline;
artifact links per phase/node; collection/frontier state once ZCode Protocol exposes it; explicit
refresh/error states per run; compact layout for narrow side panes.

Acceptance: during a real run the user can answer what is running now, what is next, what is
blocked and by what, which child session produced an artifact, and why a node retried or reopened.
Tests: pure graph derived-state tests; UI rendering tests for active/ready/blocked rows; service
tests for workflow ZCode app-server method calls; protocol test for workflow notification to
workspace event mapping.

## P6: Configurable workflow definitions — mostly done

Done: runtime-validated `WorkflowDefinition` and `WorkflowPhaseDefinition` contracts; built-in
expert phase order, behavior, artifact paths, graph seed source, and default strategy moved into a
reusable definition object; loading from `~/.zcode/cli/workflows/definitions` with runtime schema
validation; run snapshots record definition id and version; ZCode app-server starts/lists/gets/
cancels definition-backed workflow kinds without expert-only assumptions; `/expert` stays pinned to
the built-in definition.

Open: schema for agent prompt templates and allowed activity kinds; `/expert --definition <name>`
or a generic `/workflow <name>` slash command only after the schema is stable.

## Reference files

Current implementation: `docs/design/v2/expert-workflow.md`,
`packages/core/src/workflow/expert.ts`, `packages/core/src/workflow/lifecycle.ts`,
`packages/contracts/src/workflow/index.ts`, `packages/adapters/src/workflow/index.ts`,
`packages/bootstrap/src/zcode-protocol-entrypoint.ts`.

GSAP reference: `/Users/dev/workspace/zcode-cli-bak/src/gsap/pipeline/orchestrator.ts`,
`.../pipeline/executor.ts`, `.../graph/engine.ts`, `.../graph/ops.ts`.

z-code-2 debugger: `/Users/dev/workspace/z-code-2/docs/workflow-debugger.md`,
`/Users/dev/workspace/z-code-2/packages/ui/src/WorkflowDebugPane.tsx`,
`/Users/dev/workspace/z-code-2/packages/ui/src/WorkflowGraphView.tsx`,
`/Users/dev/workspace/zcode-cli/packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`.
