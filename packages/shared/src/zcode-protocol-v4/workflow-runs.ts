// ============================================================
// workflowRuns: live runtime-state schema for dwf engine runs (the workflowRuns key in snapshot.ts)
// ============================================================
// Extracted from snapshot.ts: this vocabulary is self-contained (run / actor / node / usage / limits),
// bringing snapshot.ts back within the max-lines limit (following workspace-hook-review.ts).

import { z } from "zod";

import { workflowRunArtifactSummarySchema } from "./workflow-artifacts.js";

// ── workflowRuns: live runtime state for dwf engine runs ──
// Same pattern as subagents: runtime state belongs to the authoritative conversation projection, not a renderer query cache.
// One engine RunEvent → one session event → a whole-key replacement here, so there is no dual clock from “event + separate RPC query.”
export const WORKFLOW_RUNS_LIMITS = {
  /** Most recent runs; evict the oldest when over the limit. */
  maxRuns: 8,
  /**
   * Actors and nodes share a capacity limit, so a node cannot remain visible after its owning subagent is truncated.
   * Key-level deltas mean each event transmits only changes; the capacity limit bounds each run's projection size
   * and resource use from a faulty script that keeps creating entries. The total across runs is controlled by {@link maxTotalEntries}.
   * This limits display state, not the number of subagents the engine can actually run.
   */
  maxActors: 1_024,
  maxNodes: 1_024,
  /**
   * Entry budget for the whole state key: the sum of `nodes.length + actors.length` across all runs.
   *
   * The per-run limits multiplied by {@link maxRuns} allow 16,384 entries, about 2.5 MB at ~150 bytes each —
   * close to the 16 MiB snapshot limit, and snapshots are serialized in full. This budget brings the worst case back to ~1 MB,
   * at the cost of evicting the **oldest terminal run** early (its complete facts remain in the journal and are still available on the details page).
   * When over budget, the reducer evicts only terminal runs, never a running run or the run belonging to the current event.
   */
  maxTotalEntries: 6_144,
  /**
   * **Display** budget for the Results section on the details page, intentionally much smaller than the engine's per-run report limit (256):
   * the protocol limit is a display budget, while the engine limit is the contract; they need not match. Entries over this limit remain
   * in the journal (`dwf_node.kind = "report"`), but are omitted from this high-frequency state key.
   */
  maxReports: 64,
  maxReportPreviewLength: 2_048,
  maxResultPreviewLength: 2_048,
  maxErrorLength: 2_048,
  /**
   * Number of escalated questions that can be pending at once. The real engine bound is
   * 3 per ask × in-flight asks (maxConcurrency), so 32 is enough under any realistic caps.
   * It is also a safeguard: a broken script must not be able to blow up a high-frequency state key.
   */
  maxPendingQuestions: 32,
  /** Display limit for questions and follow-up details. Matches the event payload string limit (2048), so the normal path is never truncated. */
  maxQuestionLength: 2_048,
  /** Limit for the concurrency bucket's provider key (`${providerId}/${modelId}`). */
  maxConcurrencyKeyLength: 256,
  /**
   * Wire limit for a subagent model string (`providerId/modelId`, optionally with a `$reasoningLevel` suffix). It matches the concurrency bucket's
   * provider key limit: both are the same family of identifier strings, but this one may include a reasoning-effort suffix.
   */
  maxSubagentModelLength: 256,
  /**
   * Limit for `run.concurrencyCeiling`. The ceiling is derived as `min(16, cores − 2)`; this limit only rejects malformed payloads
   * (if the reducer sees a value outside it, it treats it as unreadable and keeps the known value).
   */
  maxConcurrencyCeiling: 1_024,
  /**
   * Wire limit for subagent display names (shared by actor.name and pendingQuestion.actorName). Names are arbitrary strings written by script authors
   * (`agent("reader-" + paths.join("+"))`), so the reducer must clamp them before emitting:
   * a 131-character name once caused the renderer to reject every later frame for the parent conversation, permanently breaking the subscription.
   */
  maxActorNameLength: 128,
  /**
   * Number of user-facing artifacts. Matches the engine's
   * `ARTIFACT_CAPS.maxArtifactsPerRun` exactly, for the opposite reason to maxReports' “display budget <
   * engine contract”: the engine's artifact limit is already 32, and lowering the display limit would silently hide cards
   * from a script running at the limit, even though those cards are the whole point of this feature.
   */
  maxArtifacts: 32,
  /**
   * Number of phases that have been entered. Matches `CREATE_WORKFLOW_GRAPH_MAX_PHASES` in the display
   * payload: a phase that cannot be drawn on the timeline need not be recorded in the projection.
   */
  maxPhases: 32,
  /** Wire limit for phase names, matching display's `CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS` (the UI associates both sides by name). */
  maxPhaseNameLength: 128,
  /**
   * **Task summary** limit for one ask (`instructionsHead` in `node-queued`). Matches the engine's
   * `INSTRUCTIONS_HEAD_MAX_CHARS`: the engine already truncates to this limit, and this is the second gate on the wire.
   * 240 characters are enough to see at a glance what the subagent was asked to do; anything longer would move the full instructions over the protocol,
   * even though they are available in the journal and subagent transcript.
   */
  maxInstructionsHeadLength: 240,
  /** Limit for the most recent tool-call name (about the same size as actor/node siteId; a tool name is an identifier, not text). */
  maxLastToolNameLength: 64,
  /**
   * **Target** limit for the most recent tool call (file path or command header). Matches the engine's
   * `LAST_TOOL_TARGET_MAX_CHARS`. This is also a safety limit: it can hold a path or command header,
   * but not full arguments or file contents — neither belongs in this high-frequency state key.
   */
  maxLastToolTargetLength: 120,
} as const;

/**
 * Actors / nodes limits compiled into **legacy consumers** (the generation without `workflowRunDeltas` capability).
 *
 * ⚠ These numbers must **never change**: they are validation limits compiled into someone else's binary, not our limits. An oversized payload does not
 * lose one key; it makes the entire `state.updated` patch fail parsing and drops the whole frame, silently breaking that subscription. So before sending a frame to these consumers,
 * it must pass through `clampWorkflowRunsForLegacy`.
 *
 * “First 256” is deliberate: the legacy reducer rejected new entries at the limit, so it produced exactly the earliest 256.
 */
export const WORKFLOW_RUNS_LEGACY_LIMITS = {
  maxActors: 256,
  maxNodes: 256,
} as const;

/**
 * A phase entered by control flow (a `phase("…")` marker). `name` is the author's original term (the timeline associates it with display's `phases[].name`); `rounds` is the entry
 * count — monotonic (the reducer takes max), so replaying a prefix on resume does not double it.
 */
export const workflowRunPhaseSchema = z.object({
  name: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength),
  rounds: z.number().int().positive(),
});
export type WorkflowRunPhase = z.infer<typeof workflowRunPhaseSchema>;

/**
 * How much of the limit was consumed in a **birth phase**.
 *
 * The two counters (`nodesUnlisted` / `nodesUnlistedSettled` in {@link workflowRunUsageSchema}) say how many entries a run omitted in total,
 * but not **which phase** omitted them. The read view is drawn by phase: each phase's roster, count ring, and “N more” need to add back its own unlisted entries,
 * or a phase with a wide fan-out would display a misleadingly small number.
 *
 * Missing `phaseName` means the unphased bucket (born before any `phase()` marker or emitted by an older CLI without a phase stamp). `actors` is
 * the number of subagents in this phase **not currently in the actor table** (rejected, evicted, and removed as orphans all count),
 * `actorsSettled` is the known completed subset, `actorsFailed` is the failed subset, and `settled` is the number of unlisted settled nodes
 * attributed to this phase. `actors` can increase or decrease: an evicted subagent returns to the table when dispatched again.
 * Optional child keys with value zero are omitted; a bucket with all four counts at zero is omitted entirely (same absent-when-empty convention as elsewhere in this file).
 */
export const workflowRunUnlistedPhaseSchema = z.object({
  phaseName: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength).optional(),
  actors: z.number().int().nonnegative(),
  actorsSettled: z.number().int().nonnegative().optional(),
  actorsFailed: z.number().int().nonnegative().optional(),
  settled: z.number().int().nonnegative(),
});
export type WorkflowRunUnlistedPhase = z.infer<typeof workflowRunUnlistedPhaseSchema>;

/**
 * Run-level usage: observational, not control-plane state. `spentTokens` comes directly from the total in the engine's `usage-updated` event
 * (written in the same sync step as `dwf_run.spent_tokens`, so the two always match); `nodesUsed` counts nodes dispatched in this run from node events —
 * there is no limit from which to derive it, and none is needed.
 */
export const workflowRunUsageSchema = z.object({
  spentTokens: z.number().int().nonnegative(),
  nodesUsed: z.number().int().nonnegative(),
  /**
   * Number of instances **rejected from the table** after hitting {@link WORKFLOW_RUNS_LIMITS.maxNodes}, and how many of those have settled. `truncated` only says “something was omitted,” not
   * how many — so a run with 3,000-way fan-out would appear as “1,024 steps” in the read view, which would be false.
   *
   * Both are **additive** counters (rejected instances are not in the table and have no identity to deduplicate), so the reducer counts them only when an event
   * **advances the high-water mark**; retransmitted tail events cannot keep increasing them. `run-started` resets the entire usage object too:
   * resume replays the script prefix, and without a reset it would add both runs' steps together. Omit the whole key when zero.
   */
  nodesUnlisted: z.number().int().nonnegative().optional(),
  nodesUnlistedSettled: z.number().int().nonnegative().optional(),
});
export type WorkflowRunUsage = z.infer<typeof workflowRunUsageSchema>;

/**
 * One actor instance. `status` is a **derived** three-state value:
 * Engine Boundary C emits no actor lifecycle events except `actor-created`, so status is inferred from that actor's
 * nodes and the run's terminal state:
 *   - `running`: a node is executing / repairing / nudged (the model request was sent and is running);
 *   - `waiting`: there is a live node (queued / dispatched / waiting: not yet dispatched, waiting for a slot, or backing off),
 *     **or** there are no nodes yet and the run is not terminal (created but not yet asked);
 *   - `completed`: otherwise (all nodes settled or the run is terminal).
 * There is no observable actor-level failed state: a failed ask still means “its work is done”; the outcome is on the node.
 *
 * `sessionId` is the actor session ID (phase 5 transcript drill-down reads it directly). It is also absent from Boundary C;
 * the run service deterministically derives it from `(runId, actorRef)` using the same function.
 */
export const workflowRunActorSchema = z.object({
  siteId: z.string().min(1).max(64),
  ordinal: z.number().int().nonnegative(),
  name: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxActorNameLength).optional(),
  sessionId: z.string().min(1).max(256).optional(),
  status: z.enum(["waiting", "running", "completed"]),
  /**
   * The phase this instance was **born** in: the name of the `phase("…")` marker active when its ordinal was minted. The UI associates it with `phases[].name` by **name**;
   * this is the only vocabulary shared by the engine and analyzer, so its limit matches `maxPhaseNameLength`.
   *
   * Consumers must recognize both meanings of absence: born before any marker (the script has no `phase()` or declares it later),
   * or the event came from an older CLI that did not include this key.
   */
  phaseName: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength).optional(),
});
export type WorkflowRunActor = z.infer<typeof workflowRunActorSchema>;

/**
 * **Most recent** tool call in an ask (carried by `node-progress`). `name` is the tool name; `target` is a
 * short, label-sized target — a file-tool path or Bash command header; omitted when unavailable.
 *
 * **Intentionally only these two keys**: full arguments and file contents do not go into this high-frequency state key (one update per parsed turn);
 * they are in the journal and subagent transcript. Thus the `target` limit is both a display budget and a guard for that constraint.
 */
export const workflowRunNodeLastToolSchema = z.object({
  name: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxLastToolNameLength),
  target: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxLastToolTargetLength).optional(),
});
export type WorkflowRunNodeLastTool = z.infer<typeof workflowRunNodeLastToolSchema>;

/**
 * One node (ask / world-read) instance. `phase` is the node event **actually emitted** by the engine:
 *   queued → dispatched → executing ⇄ waiting → (repairing | nudged) → settled.
 * `executing` / `waiting` come from driver observations:
 * `node-executing` means the ask's model request was actually sent; `node-waiting` means it is waiting for a process-level slot or backing off.
 * `dispatched` is therefore a brief phase meaning “session ready, first request not yet admitted”; the read view groups it with queued / waiting as “waiting.”
 *
 * `kind` may be absent: on resume, a completed cache hit short-circuits directly to `node-settled` (asks use
 * releaseCachedAsk / tryImportedSettle in scheduler.ts; world-read uses replay and imported hits in engine-world.ts),
 * bypassing `node-queued`, while kind is carried only on queued.
 */
export const workflowRunNodeSchema = z.object({
  siteId: z.string().min(1).max(64),
  ordinal: z.number().int().nonnegative(),
  kind: z.enum(["ask", "world-read"]).optional(),
  phase: z.enum(["queued", "dispatched", "executing", "waiting", "repairing", "nudged", "settled"]),
  outcome: z.enum(["ok", "failed", "cancelled"]).optional(),
  cached: z.boolean().optional(),
  /** Site ID of the actor that owns this node (world-read has no actor). */
  actorSiteId: z.string().min(1).max(64).optional(),
  actorOrdinal: z.number().int().nonnegative().optional(),
  /**
   * The phase this instance was **born** in,
   * with exactly the same meaning as the matching key in {@link workflowRunActorSchema}: the `phase("…")` marker name active when its ordinal was minted;
   * the UI associates it with `phases[].name` by name. Missing means it was born before any marker or came from an older CLI.
   *
   * ⚠ This is **not** the same as `phase` above: `phase` is the node lifecycle phase (queued / executing /
   * settled, etc.); `phaseName` is the script phase coordinate. It is deliberately not named `phase` to keep the concepts distinct.
   *
   * The engine stamps only the **birth event** (`node-queued` and, on replay hits, a direct
   * `node-settled { cached: true }`); other `node-*` events omit it and the reducer carries it forward.
   */
  phaseName: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength).optional(),
  /**
   * The **task** for this ask: the first 240 characters of the author's `instructions`, delivered with `node-queued`. The read view uses it to answer “what was this subagent asked to do?” —
   * a phase only says “running,” not what it is doing.
   *
   * This is the head of the **author's original text**, excluding suffixes later added by the engine (runtime scaffolding, not the task).
   * Consumers must recognize both meanings of absence: a world-read node (no instructions) or an older CLI/journal without this key.
   */
  instructionsHead: z
    .string()
    .min(1)
    .max(WORKFLOW_RUNS_LIMITS.maxInstructionsHeadLength)
    .optional(),
  /**
   * Parsed-turn number for this ask (starting at 1, including nudge turns), cumulative tool-call count, and most recent
   * tool call — delivered with `node-progress`, one entry per parsed turn.
   *
   * Together, these answer “is it making progress?” For an ask stuck in `executing` for ten minutes, these readings distinguish
   * “doing a long task” from “dead.” **All three keys are absent in old journals without `node-progress`**;
   * the read view must show absence as “unknown,” not 0 — zero means “no tools have been called.”
   *
   * Reduction uses **latest value wins**, not max (unlike `phases[].rounds`): when the same instance is
   * queued again on resume, it is a new ask whose turns restart at 1; max would freeze the previous run's reading here.
   */
  turn: z.number().int().positive().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  lastTool: workflowRunNodeLastToolSchema.optional(),
});
export type WorkflowRunNode = z.infer<typeof workflowRunNodeSchema>;

/**
 * Current concurrency state for this run. There are two limits;
 * actual concurrency is **the lower of the two**:
 *
 * - `cap`: current **shared** gate for this run's provider key (the coordinator buckets by key, fans out by run,
 *   and updates it on `concurrency-changed`); `ceiling`: CPU-derived maximum. Events do not include ceiling;
 *   reduction derives it from the largest `previous` / `next` seen by this run (the bucket starts at the ceiling, so the first event's
 *   `previous` is it; in a decreasing-only sequence it remains the maximum).
 * - `limit`: this run's **own** limit (`max_concurrency` from `CreateWorkflow` / `AmendWorkflow`
 *   mapped to `caps.maxConcurrency`), delivered with `run-started` and stable for the run. **Present only when below the ceiling**:
 *   a run at the ceiling is unchanged and needs no extra key.
 * - `cooldownMs`: duration for which rate limiting with Retry-After blocks new dispatches, a **relative value** (same reason as `retryInMs`);
 *   cleared by `idle_reset` and terminal run state.
 *
 * UI shows the reading only when `min(cap, limit) < ceiling` (see workflowRunConcurrencyView).
 */
export const workflowRunConcurrencySchema = z.object({
  key: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxConcurrencyKeyLength).optional(),
  cap: z.number().int().positive(),
  ceiling: z.number().int().positive(),
  limit: z.number().int().positive().optional(),
  cooldownMs: z.number().int().nonnegative().optional(),
});
export type WorkflowRunConcurrency = z.infer<typeof workflowRunConcurrencySchema>;

/**
 * **Incremental output** produced by a script's `report(item)` (one row in the details page Results section).
 *
 * `report` is different from `log`: it has a site identity, is recorded in the journal, and has its own `RunEvent`, so it goes into
 * the event log and Results section and is returned to the model in completion notifications. But it **does not enter the causality graph** (progress only,
 * with no ordering meaning) or **`nodes[]`** — a workflow that reports frequently should not appear to have more steps.
 *
 * `siteId × ordinal` is the identity (the journal key) and the reducer's deduplication key: each
 * `report` call runs again during script replay, and the same instance must remain one row, not two.
 *
 * Store **preview text**, not the original value: serialization (strings as-is; everything else as pretty JSON) shares the same path as
 * run artifact projection, computed once on the CLI side so the renderer does not need a duplicate serialization contract; this also
 * enforces the invariant that all payloads at the protocol boundary are bounded through one string limit.
 */
export const workflowRunReportSchema = z.object({
  siteId: z.string().min(1).max(64),
  ordinal: z.number().int().nonnegative(),
  preview: z.string().max(WORKFLOW_RUNS_LIMITS.maxReportPreviewLength),
  /**
   * Second argument to `report(item, artifactId)`: which **preconfigured board** receives this entry. Missing means it is untagged and appears only in Results as before.
   *
   * Tagged entries **still go into `reports`**: each channel has its own limit; the tag adds a destination rather than redirecting the entry.
   * Limit matches artifact IDs (64), because this is an artifact ID.
   */
  artifactId: z.string().min(1).max(64).optional(),
});
export type WorkflowRunReport = z.infer<typeof workflowRunReportSchema>;

/**
 * An escalation question that is **pending**: an actor encounters a real blocker
 * (a broken gate, contradictory instructions, or missing critical facts), escalates to the primary agent, and waits for an answer in its ask.
 *
 * Identity is `qid` (globally unique across runs), not a site instance — an escalation has **no** site identity: it writes no `dwf_node`
 * row and does not count toward maxNodes; it is a slow tool call **inside** an ask turn. So qid is the deduplication key and actor is only
 * an attribute. This differs from the nodes/actors/reports tables, which deduplicate by (siteId, ordinal).
 *
 * `actorSiteId` / `actorOrdinal` may therefore be absent (matching the corresponding pair on `WorkflowRunNode`): a record with an unknown asker
 * must still be displayed — this feature exists to make blocked questions **visible**, and hiding one because its actor ref cannot be read would defeat its only fallback value.
 * `actorName` is the persona name; anonymous actors omit it (the event side deliberately does not synthesize a fallback label, leaving each consumer to render “unnamed”).
 *
 * **In-memory only, cleared when the run becomes terminal**: the source of truth is pending deferreds inside the CLI process. When the process exits, those deferreds disappear,
 * so a terminal run can never have an outstanding answer — by definition, no one is listening on a terminal run.
 */
export const workflowRunPendingQuestionSchema = z.object({
  /** Globally unique question ID (for example, `dwfq-<runId fragment>-<seq>`); the primary agent answers by this ID. */
  qid: z.string().min(1).max(128),
  actorSiteId: z.string().min(1).max(64).optional(),
  actorOrdinal: z.number().int().nonnegative().optional(),
  actorName: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxActorNameLength).optional(),
  question: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxQuestionLength),
  context: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxQuestionLength).optional(),
  /**
   * Time the question was asked (epoch milliseconds), carried by the event — this module is a pure reducer and has no clock.
   *
   * **Required** on the event side (the driver is the sole producer and uses the same `Date.now()` as the pending record), but still optional here:
   * journals on older developer machines may replay events from before askedAt existed. The renderer should show wait duration when present;
   * absence is not an error.
   */
  askedAt: z.number().int().nonnegative().optional(),
});
export type WorkflowRunPendingQuestion = z.infer<typeof workflowRunPendingQuestionSchema>;

export const workflowRunSchema = z.object({
  runId: z.string().min(1).max(128),
  /** CreateWorkflow tool call that started this run (correlation key from the tool card to the details page). */
  toolCallId: z.string().min(1).max(128).optional(),
  status: z.enum(["pending", "running", "completed", "errored", "stopped"]),
  /** Present only when `status === "stopped"`. */
  stopReason: z.enum(["user", "model", "provider", "interrupted", "superseded"]).optional(),
  /**
   * The two ends of the lineage: which run this run revises
   * (`resumedFrom` in the `run-started` payload), and which revision stopped and replaced this run (`supersededBy` in the `run-settled` payload,
   * present only with `stopReason: "superseded"`). Both are optional for the same reason as `reports`:
   * adding fields to an existing state key means older CLIs that omit them produce a degraded response, not a dropped frame.
   */
  resumedFrom: z.string().min(1).max(128).optional(),
  supersededBy: z.string().min(1).max(128).optional(),
  usage: workflowRunUsageSchema,
  error: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxErrorLength).optional(),
  /**
   * Resumable. **Present only when true**.
   *
   * CLI supplies this in the `run-settled` payload using the same predicate as the resume gate (computed by toProgressPayload for live state,
   * and seeded from journal rows during cold replay); the reducer only carries it through. The UI must never infer it from status + failureCode
   * (the predicates could diverge, showing an enabled button for a rejected command). Optional for the same reason as `reports`: adding
   * a field to an existing state key means older CLIs that omit it produce a degraded response, not a dropped frame.
   */
  resumable: z.literal(true).optional(),
  resultPreview: z.string().max(WORKFLOW_RUNS_LIMITS.maxResultPreviewLength).optional(),
  actors: z.array(workflowRunActorSchema).max(WORKFLOW_RUNS_LIMITS.maxActors),
  nodes: z.array(workflowRunNodeSchema).max(WORKFLOW_RUNS_LIMITS.maxNodes),
  /**
   * Incremental outputs emitted by `report(item)`, in report order. **Omit the whole key when empty** (not an empty array):
   * the Results section uses this to hide the entire section rather than leave an empty shell for workflows that do not use `report`.
   *
   * Intentionally optional rather than required: this adds a field to an **existing state key**, and parse errors on known keys
   * are not stripped — they fail the whole `state.updated` patch and drop the entire frame.
   * If required, every older CLI that does not send reports would trigger that failure; optional makes it degrade to “one missing key.”
   */
  reports: z.array(workflowRunReportSchema).max(WORKFLOW_RUNS_LIMITS.maxReports).optional(),
  /**
   * Pending escalation questions, in question order. **Omit the whole key when empty** (not an empty array), following the same
   * convention as `reports`: the sidebar hides the entire section rather than leaving an empty shell for a run with no questions.
   *
   * Empty is the **normal state** for this key, and it comes and goes: answered questions disappear from the table, and after the last answer
   * the key is absent again. Consumers must not assume that a key seen once will remain present.
   *
   * The second reason for optional is the same as for `reports`: this adds a field to an **existing state key**, and parse errors on known keys
   * are not stripped — making it required would drop the entire frame from any older CLI that does not send it.
   */
  pendingQuestions: z
    .array(workflowRunPendingQuestionSchema)
    .max(WORKFLOW_RUNS_LIMITS.maxPendingQuestions)
    .optional(),
  /**
   * Current concurrency state (see {@link workflowRunConcurrencySchema}). Present only when **one of the two limits is below the ceiling**:
   * the run received `concurrency-changed` (rate limiting lowered the shared bucket), or `run-started` supplied a `limit` below the ceiling
   * (the user capped this run). A run with neither always runs at the ceiling, so there is nothing to report.
   * Optional for the same reason as `reports` / `pendingQuestions`.
   */
  concurrency: workflowRunConcurrencySchema.optional(),
  /**
   * Local concurrency ceiling (`concurrencyCeiling` in the `run-started` payload, a process fact added by the CLI when building the payload).
   * Unlike `concurrency.ceiling`, which is the reading chip's limit and appears only when the chip is present, this one is **always present when known**,
   * whether or not this run is below it — the stepper in the “Settings” dialog stops here. Optional for the same reason as `concurrency`: an older CLI omits it, resulting in a degraded response.
   */
  concurrencyCeiling: z
    .number()
    .int()
    .positive()
    .max(WORKFLOW_RUNS_LIMITS.maxConcurrencyCeiling)
    .optional(),
  /**
   * Model used by this run's **subagents** (`subagent_model` from `CreateWorkflow` / `AmendWorkflow`
   * mapped to `subagentModel` in the payload), in canonical `providerId/modelId` form, optionally with a `$reasoningLevel` suffix.
   * Arrives with `run-started` and remains fixed for the run — like `concurrency.limit`, it is a condition set by the user for this run
   * and does not change at runtime.
   *
   * **Present only when the user selected a model for this run**: otherwise subagents follow the conversation model, so there is nothing to report.
   * The primary agent always stays on the conversation model, so this key applies only to subagents.
   * Optional for the same reason as `reports` / `concurrency`: adding a field to an existing state key means older CLIs that omit it
   * produce a degraded response, not a dropped frame.
   */
  subagentModel: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxSubagentModelLength).optional(),
  /**
   * **User-facing artifacts** published by this run, in first-seen order, with only the **latest** metadata for each item. **Omit the whole key when empty** (not an empty array):
   * the sidebar uses this to hide the Artifacts section entirely — absent when empty, following `reports` / `pendingQuestions`.
   *
   * The second reason for optional matches `reports` exactly, and is the one that matters here: this adds a field to an **existing
   * state key**, and parse errors on known keys are not stripped — requiring it would drop the whole frame from every older CLI that sends no artifacts.
   * A missing key is degraded data, not an error.
   *
   * ⚠ Terminology: artifact here means output the script publishes for users, not the “top-level return value” behind `resultPreview`
   * (also called an artifact internally by the engine). See the header of workflow-artifacts.ts.
   */
  artifacts: z
    .array(workflowRunArtifactSummarySchema)
    .max(WORKFLOW_RUNS_LIMITS.maxArtifacts)
    .optional(),
  /**
   * Phases that have been entered, in first-entry order.
   * **Omit the whole key when empty**; optional for exactly the same reason as `reports` (older CLIs omit it, so a missing key is degraded data,
   * not an error). The timeline uses it to light phases with zero members and show all phases as running before the first ask is dispatched.
   */
  phases: z.array(workflowRunPhaseSchema).max(WORKFLOW_RUNS_LIMITS.maxPhases).optional(),
  /** Name of the last phase entered by control flow (the final `phase-entered`); absent if no phase was ever entered. */
  currentPhase: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength).optional(),
  /**
   * Phases **declared** by the script, in declaration order (`run-launched.phaseNames`). Complements `phases` (entered phases): the sidebar mini-track uses it to show upcoming phases.
   * Omit the whole key when empty, from an older CLI, or from a script without phase markers.
   */
  phaseNames: z
    .array(z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength))
    .max(WORKFLOW_RUNS_LIMITS.maxPhases)
    .optional(),
  /**
   * “Running alongside” table aligned **by index** with `phaseNames` (`run-launched.phaseAlongside`):
   * `phaseAlongside[i]` contains **indices** of other phases whose strands were still running when `phaseNames[i]` was entered; indices refer to
   * the `phaseNames` table. The sidebar mini-track uses this to draw a double segment between parallel phases.
   *
   * Depends on `phaseNames`: absent if that key is absent; also absent when no phases run in parallel — absence means
   * “this track is a straight line.” Reduction ensures every index refers to the accepted table (workflow-runs-phases.ts).
   */
  phaseAlongside: z
    .array(z.array(z.number().int().nonnegative()).max(WORKFLOW_RUNS_LIMITS.maxPhases))
    .max(WORKFLOW_RUNS_LIMITS.maxPhases)
    .optional(),
  /**
   * How much of the limit was consumed in each birth phase (see {@link workflowRunUnlistedPhaseSchema}). **Omit the entire key
   * when there are no buckets**. The table may have one more entry than `maxPhases`: the extra entry is the unphased bucket, in the same table as named phases.
   *
   * After the table is full, new phase attribution is **dropped**; the two run-level counters remain accurate — a phase may lack a count it never had,
   * but the run total must not be false.
   */
  unlistedByPhase: z
    .array(workflowRunUnlistedPhaseSchema)
    .max(WORKFLOW_RUNS_LIMITS.maxPhases + 1)
    .optional(),
  /**
   * Set when actors / nodes / reports / pendingQuestions / artifacts / phases hit their limits;
   * raw facts remain in the journal. Eviction (to make room for active newcomers) also sets this: the run's entry table can no longer hold all its facts,
   * and `run-started` uses this flag to decide whether to restart the next incarnation with an empty table.
   */
  truncated: z.boolean().optional(),
  /** Journal sequence of the last reduced event; an increase triggers an event-log refetch. */
  lastEventSequence: z.number().int().nonnegative(),
});
export type WorkflowRunState = z.infer<typeof workflowRunSchema>;

export const workflowRunsStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  runs: z.array(workflowRunSchema).max(WORKFLOW_RUNS_LIMITS.maxRuns),
});
export type WorkflowRunsState = z.infer<typeof workflowRunsStateSchema>;
