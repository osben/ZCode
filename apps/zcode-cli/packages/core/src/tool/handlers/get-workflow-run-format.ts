// ============================================================
// GetWorkflowRun's model-facing output: TaskOutput-style XML-ish blocks
// ============================================================
// Split from the handler (which reached its 400-line limit); the three situational blocks were then split into
// get-workflow-run-format-roster.ts.
//
// This is a **pure function** `(output) => text`: the handler has already put all clock readings into `generatedAt`, and the formatter
// never touches `Date.now()`. One output therefore uses one clock; any two “time ago” values are comparable, and tests can assert the
// entire text exactly.
//
// Block order is part of the contract: first summarize the situation, then identity and lifecycle, then **what the model needs to do
// now** (parked questions), followed by run health, narrative, outcome, and routing.

import {
  GetWorkflowRunOutputSchema,
  type GetWorkflowRunOutput,
  type ModelMessageContent,
} from "@zcode/contracts";
import { formatWorkflowProviderStopError } from "../../runtime-task/notification.js";
import { formatPublishedArtifactLine } from "../executor/workflow-published-artifacts.js";
import {
  formatWorkflowRunHealthBlock,
  formatWorkflowRunLogTailBlock,
  formatWorkflowRunPhasesBlock,
  formatWorkflowRunSubagentsBlock,
} from "./get-workflow-run-format-roster.js";
import {
  escapeWorkflowRunText,
  formatRelativeAge,
  formatWorkflowRunInstant,
  formatWorkflowRunTimestamp,
  workflowRunAttribute,
} from "./workflow-run-introspection.js";

/** Three terminal states: the run has no next action (same set as the summary). */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "errored", "stopped"]);

/**
 * Message used when a parked question **cannot be found**. This is one of only two places in the tool that explicitly says “unknown”:
 * silence would be read as “nobody is waiting,” the most dangerous misreading because an actor is parked there with no timeout fallback.
 */
const PENDING_QUESTIONS_UNKNOWN =
  "Unknown: pending questions are tracked only by the process that owns the run, and this session does not. Resuming the run will re-ask any question its subagent still needs answered.";

const PENDING_QUESTIONS_INSTRUCTION =
  "Each of these subagents is parked waiting for an answer and nothing times out on its behalf. Answer one with ResolveWorkflowQuestion using the ID in brackets. The rest of the run keeps running meanwhile.";

export function formatGetWorkflowRunModelContent(output: unknown): ModelMessageContent {
  const parsed = GetWorkflowRunOutputSchema.safeParse(output);
  if (!parsed.success) return "GetWorkflowRun returned an invalid result.";
  const run = parsed.data;
  const terminal = TERMINAL_STATUSES.has(run.status);

  const blocks = [
    // Put the one-line status first; each later block expands on it, and the reader needs context before the details.
    `<summary>${escapeWorkflowRunText(run.summary)}</summary>`,
    ...identityBlocks(run),
    ...pendingQuestionBlocks(run),
    ...holeBlocks(run),
    formatWorkflowRunHealthBlock(run, terminal),
    ...optionalBlock(formatWorkflowRunPhasesBlock(run, terminal)),
    formatWorkflowRunSubagentsBlock(run),
    formatWorkflowRunLogTailBlock(run),
    usageBlock(run),
    ...outcomeBlocks(run),
    ...routingBlocks(run),
  ];
  return blocks.join("\n\n");
}

function optionalBlock(block: string | undefined): string[] {
  return block === undefined ? [] : [block];
}

/** Identity and lifecycle: one label per fact, with no empty labels for absent facts. */
function identityBlocks(run: GetWorkflowRunOutput): string[] {
  const blocks = [
    `<run_id>${escapeWorkflowRunText(run.runId)}</run_id>`,
    `<label ${workflowRunAttribute("source", run.labelSource)}>${escapeWorkflowRunText(run.label)}</label>`,
    `<status>${escapeWorkflowRunText(run.status)}</status>`,
    ...(run.stopReason === undefined
      ? []
      : [`<stop_reason>${escapeWorkflowRunText(run.stopReason)}</stop_reason>`]),
    ...(run.resumedFrom === undefined
      ? []
      : [`<resumed_from>${escapeWorkflowRunText(run.resumedFrom)}</resumed_from>`]),
    // Present only when this run lowered its concurrency (the port omits it otherwise). AmendWorkflow reuses this value when
    // `max_concurrency` is omitted, so the model can see what the revision will inherit.
    ...(run.maxConcurrency === undefined
      ? []
      : [`<max_concurrency>${run.maxConcurrency}</max_concurrency>`]),
    // Another run-level setting: present only when this run selected a subagent model.
    ...(run.subagentModel === undefined
      ? []
      : [`<subagent_model>${escapeWorkflowRunText(run.subagentModel)}</subagent_model>`]),
    // Same format: one `"name" = canonical ID` per script-named model; include only when the script names models.
    ...(run.modelBindings === undefined || Object.keys(run.modelBindings).length === 0
      ? []
      : [
          `<script_models>\n${Object.entries(run.modelBindings)
            .map(
              ([name, canonical]) =>
                `"${escapeWorkflowRunText(name)}" = ${escapeWorkflowRunText(canonical)}`,
            )
            .join("\n")}\n</script_models>`,
        ]),
    ...(run.supersededBy === undefined
      ? []
      : [`<superseded_by>${escapeWorkflowRunText(run.supersededBy)}</superseded_by>`]),
    `<owned_by_this_session>${run.ownedByThisSession}</owned_by_this_session>`,
  ];
  if (run.possiblyInterrupted) {
    blocks.push(
      "<possibly_interrupted>true — this session cannot confirm the run is still alive</possibly_interrupted>",
    );
  }
  // ISO timestamp plus age: the former is a verifiable fact, the latter is what the reader actually wants.
  blocks.push(
    `<created_at>${formatWorkflowRunInstant(run.generatedAt, run.createdAt)}</created_at>`,
  );
  blocks.push(
    `<updated_at>${formatWorkflowRunInstant(run.generatedAt, run.updatedAt)}</updated_at>`,
  );
  return blocks;
}

/**
 * Parked escalation questions go before health, roster, and narrative. Those sections describe how the run is doing, but this section
 * is **an action waiting for the model now**; burying it below twenty narrative lines would hide the only way to unblock the run.
 */
function pendingQuestionBlocks(run: GetWorkflowRunOutput): string[] {
  if (!run.health.pendingQuestionsKnown) {
    return [`<pending_questions>${PENDING_QUESTIONS_UNKNOWN}</pending_questions>`];
  }
  const questions = run.pendingQuestions ?? [];
  if (questions.length === 0) return [];
  const rendered = questions.map((question) => {
    const who = question.actorName ?? question.actor;
    const age = formatRelativeAge(run.generatedAt, question.askedAt);
    const asked =
      age === undefined
        ? `asked at ${formatWorkflowRunTimestamp(question.askedAt)}`
        : `asked ${age}`;
    const lines = [
      `[${escapeWorkflowRunText(question.qid)}] ${escapeWorkflowRunText(who)} ${asked}`,
      escapeWorkflowRunText(question.question),
    ];
    if (question.context !== undefined)
      lines.push(`context: ${escapeWorkflowRunText(question.context)}`);
    return lines.join("\n");
  });
  return [
    `<pending_questions>\n${rendered.join("\n\n")}\n\n${PENDING_QUESTIONS_INSTRUCTION}\n</pending_questions>`,
  ];
}

/**
 * Holes (docs/dynamic-workflow/launch.md, “The `FillWorkflowHole` tool”) follow pending questions: a pending hole and an unanswered question are both tasks waiting for the model now;
 * list filled holes afterward only to tell the model that branch has resumed. Use the same routing style as `<amendable>`: name FillWorkflowHole and the `hole_id` to pass at the end of the block.
 */
function holeBlocks(run: GetWorkflowRunOutput): string[] {
  const holes = run.holes ?? [];
  if (holes.length === 0) return [];
  const rendered = holes.map((hole) => {
    const head = `[${escapeWorkflowRunText(hole.siteId)}] "${escapeWorkflowRunText(hole.name)}": ${escapeWorkflowRunText(hole.type)}`;
    if (hole.state === "waiting") {
      const age = formatRelativeAge(run.generatedAt, hole.since);
      return `${head} — waiting${age === undefined ? "" : ` ${age.replace(/ ago$/u, "")}`}`;
    }
    const age = formatRelativeAge(run.generatedAt, hole.filledAt);
    const by = hole.filledBy === undefined ? "" : ` by ${escapeWorkflowRunText(hole.filledBy)}`;
    return `${head} — filled${age === undefined ? "" : ` ${age}`}${by}`;
  });
  const waiting = holes.filter((hole) => hole.state === "waiting").length;
  const instruction =
    waiting === 0
      ? "Every hole above has been filled; its body is part of the run's script now (see <amendable> to change it)."
      : `Each waiting hole parks one branch of the script until you supply its body, and nothing times out on its behalf. Read the run's draft for context, write only the statements of the hole's function returning its type, and call FillWorkflowHole with run_id="${escapeWorkflowRunText(run.runId)}" and the hole id in brackets as hole_id. The rest of the run keeps running meanwhile.`;
  return [`<holes>\n${rendered.join("\n")}\n\n${instruction}\n</holes>`];
}

/** nodes_observed is the number of persisted node rows; never present it as a total because dynamic workflows have no static total. */
function usageBlock(run: GetWorkflowRunOutput): string {
  const usage = [
    `spent_tokens=${run.usage.spentTokens}`,
    `nodes_observed=${run.usage.nodesObserved}`,
    `nodes_running=${run.usage.nodesRunning}`,
    `nodes_completed=${run.usage.nodesCompleted}`,
    `nodes_failed=${run.usage.nodesFailed}`,
  ].join(" ");
  return `<usage>${usage}</usage>`;
}

/** Run outcome: result → error → user-facing artifact list (same order as completion notifications). */
function outcomeBlocks(run: GetWorkflowRunOutput): string[] {
  const blocks: string[] = [];
  if (run.result !== undefined) {
    // Include the result verbatim (without escaping): it may be JSON or code, and escaping would make the model see something different from the actual artifact.
    blocks.push(`<result>\n${run.result}\n</result>`);
  }
  if (run.error !== undefined) {
    // Provider stopped: `<error>` is the full message produced by the same function as terminal notifications (cause → action → facts →
    // original text), so the model sees identical text through both readers. Include it verbatim, following `<result>`: it contains
    // copyable fragments such as `run_id="…"`, which would be copied incorrectly if escaped as &quot;. Other failures remain a single message.
    const body =
      run.error.providerStop === undefined
        ? escapeWorkflowRunText(run.error.message)
        : `\n${formatWorkflowProviderStopError(run.error, run.runId)}\n`;
    blocks.push(`<error ${workflowRunAttribute("code", run.error.code)}>${body}</error>`);
  }
  // Put user-facing artifacts **after** result/error, matching completion notifications: the run outcome is what the model must read
  // first; the artifact list is an index. Share the row formatter verbatim with completion notifications.
  if (run.artifacts !== undefined && run.artifacts.length > 0) {
    const lines = run.artifacts.map((artifact) =>
      escapeWorkflowRunText(formatPublishedArtifactLine(artifact)),
    );
    blocks.push(`<artifacts count="${run.artifacts.length}">\n${lines.join("\n")}\n</artifacts>`);
  }
  return blocks;
}

/** Routing: a replaced run points only to its successor; otherwise, resumability and revisability each get their own section. */
function routingBlocks(run: GetWorkflowRunOutput): string[] {
  const blocks: string[] = [];
  if (run.stopReason === "superseded") {
    // A replaced run cannot be resumed (its successor is active) or revised again; revise the successor instead.
    const successor =
      run.supersededBy === undefined
        ? "its successor"
        : `run ${escapeWorkflowRunText(run.supersededBy)}`;
    blocks.push(
      `<superseded>This run was stopped by an AmendWorkflow and superseded by ${successor}, which owns its unfinished work. Do not resume it (ResumeWorkflowRun will refuse) and do not amend it again; read or amend ${successor} instead.</superseded>`,
    );
    return blocks;
  }
  if (isWorkflowRunResumableOutput(run)) blocks.push(formatResumableHint(run));
  blocks.push(formatAmendableHint(run));
  return blocks;
}

/**
 * All four stop reasons are resumable, but the next step differs: a user stop was intentional (resume only when requested by the user);
 * a provider stop requires resolving its cause first; model/interrupted can resume directly. Include this guidance so the model does not
 * treat a run the user just cancelled as an incident and restart it.
 */
function formatResumableHint(run: GetWorkflowRunOutput): string {
  const reasonSentence =
    run.stopReason === "user"
      ? " This run was stopped on purpose by the user: resume it only when the user asks."
      : run.stopReason === "model"
        ? " You stopped this run yourself with TaskStop: resume it unchanged only if that is what the user wants. If you stopped it to fix the script, do not wait — amend it now, see <amendable>."
        : run.stopReason === "provider"
          ? " A provider-side error stopped it: resolve the cause named in <error> with the user before resuming, or it will stop again the same way."
          : "";
  return `<resumable>This run can be continued with ResumeWorkflowRun — it will resume under the same run ID, replaying finished steps and re-dispatching the unfinished ones.${reasonSentence} The script must be byte-for-byte the one this run was started with; to change it, see <amendable>.</resumable>`;
}

/**
 * Routing guidance for revision-resume (amend-resume). This is parallel to, not a replacement for, `<resumable>`: the predicates
 * and actions differ, so keep separate sections that state the distinction (same run/same script vs new run/new script).
 *
 * The final sentence varies by state: a genuine script failure is the most valuable case for revision (fix a bug while preserving
 * cached work), while the model's default reaction is to rewrite from scratch, discarding all work and tokens already spent.
 *
 * **A healthy running run gets only one sentence**: there is no decision for the model to make now, and a full routing argument would
 * distract from the roster. Show the complete reasoning only when stalled, not yet started, or terminal.
 */
function formatAmendableHint(run: GetWorkflowRunOutput): string {
  // Include the script-file sentence in both branches. The healthy-running branch gets only one sentence, and it must explain how to
  // revise; without the file, the model would have to paste the entire script inline again.
  const scriptSentence =
    run.scriptPath === undefined
      ? ""
      : ` Its script is at ${escapeWorkflowRunText(run.scriptPath)}: edit that file in place and pass \`path: "${escapeWorkflowRunText(run.scriptPath)}"\` to AmendWorkflow instead of a script.`;
  if (run.status === "running" && run.health.stalledSince === undefined) {
    return `<amendable>AmendWorkflow with run_id "${escapeWorkflowRunText(run.runId)}" supersedes this run with a revised script and imports its finished work as cache.${scriptSentence}</amendable>`;
  }
  const tail =
    run.status === "errored"
      ? "This is the highest-value case for it: the script itself failed, so fix the script and re-run — every step that already succeeded is imported instead of being paid for a second time. Do NOT rewrite from scratch."
      : run.status === "completed"
        ? "Use it to extend or refine a finished workflow — added steps run live, unchanged ones cost nothing."
        : run.status === "stopped"
          ? "Use it when the script or a setting needs to change; use ResumeWorkflowRun to continue it unchanged. A run stopped because its script was wrong is amended now, not after the user asks: the cache holds everything that settled before the stop, and waiting buys nothing."
          : "It is still running: if the script is visibly wrong, amend it now — AmendWorkflow stops this run, imports everything that settled so far, and starts the revision in one call. Do not TaskStop it first and do not wait for it to finish.";
  const body = [
    `This run can be superseded by a revised script: call AmendWorkflow with \`run_id: "${escapeWorkflowRunText(run.runId)}"\` and your new script.`,
    "That mints a NEW run and imports this one's finished work as a warm cache — matched per named subagent along its conversation prefix — so steps you did not change settle from cache at zero tokens and only the revised part runs live.",
    // Omission means reuse. Without saying so, the model may paste the entire script again just to change one number.
    "To change only its settings (max_concurrency, subagent_model, name), omit both `script` and `path`: the new run keeps this run's script.",
    tail,
  ].join(" ");
  return `<amendable>${body}${scriptSentence}</amendable>`;
}

/**
 * Predicate for resumable terminal states, with the **same semantics** as the `port.resume` gate: `stopped`, regardless of reason.
 * **Never** include `errored`: replaying a genuine script failure would reproduce the failure exactly. This is routing guidance, not
 * a guarantee of permission; the gate remains on the port.resume service.
 */
function isWorkflowRunResumableOutput(run: GetWorkflowRunOutput): boolean {
  return run.status === "stopped";
}
