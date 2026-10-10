// Session record for GUI configuration changes.
// Queue a settings turn in the runtime, record from/to for both settings, and distinguish a revision that creates a new run from an in-place concurrency adjustment.
// dynamic-workflow-run-settings.ts owns the change decision and side-effect order.

import type { TraceContext, WorkflowSettingsAmendMeta } from "@zcode/contracts";
import type { DynamicWorkflowRunSnapshot } from "@zcode/contracts";
import { uuidv7 } from "@zcode/shared";
import { createRuntimeCommandId } from "../command-queue.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { boundWorkflowLaunchMeta } from "@zcode/contracts";

/** Normalized form of this run's two settings: absence means default (session model / local concurrency limit). */
export interface RunSettings {
  subagentModel?: string;
  maxConcurrency?: number;
}

/**
 * Do not persist a settings turn directly in the command handler: the main agent may be in a turn and cannot accept a user message.
 * Queue it in the runtime; run immediately when idle or wait for the current turn to finish. It has notification priority, so it runs before any notification for the new run.
 */
export function enqueueSettingsTurn(
  this: AgentRuntimeInternal,
  turn: {
    text: string;
    meta: ReturnType<typeof boundWorkflowLaunchMeta>;
    titleInput: string;
    traceContext: TraceContext;
  },
): void {
  this.enqueueRuntimeCommand({
    branchGeneration: this.branchGeneration,
    createdAt: new Date(),
    id: createRuntimeCommandId(),
    inputId: uuidv7(),
    mode: "control-only-turn",
    priority: "next",
    text: turn.text,
    titleInput: turn.titleInput,
    traceContext: turn.traceContext,
    workflowLaunch: turn.meta,
  });
}

export function fromTo<T>(from: T | undefined, to: T | undefined): { from?: T; to?: T } {
  return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
}

/**
 * Canonical model-facing sentence for a settings turn (English, not localized because it enters the provider transcript). Mention only changed settings; each `null`
 * has its own sentence. The final sentence discourages the model from changing this run again: it is already running, and progress will arrive in notifications.
 *
 * The two outcomes diverge here based on whether `amend.predecessorRunId` is present (absence means in-place effect, matching the metadata):
 * a revision creates a new run, while an in-place concurrency adjustment keeps the same run. Using the revision wording would make the model look for
 * a nonexistent run B.
 */
export function buildSettingsMessageText(input: {
  name?: string;
  previous: string;
  runId: string;
  superseded: boolean;
  amend: WorkflowSettingsAmendMeta;
}): string {
  const inPlace = input.amend.predecessorRunId === undefined;
  const lead = `Changed the settings of workflow run ${input.previous}${input.name === undefined ? "" : ` ("${input.name}")`} from the GUI: ${settingsChangeClauses(input.amend, inPlace).join("; ")}.`;
  const closing =
    "Progress and results arrive as background notifications; do not amend, resume or restart it.";
  if (inPlace) {
    const kept =
      input.amend.maxConcurrency?.to === undefined
        ? `Run ${input.previous} keeps running with no limit`
        : `Run ${input.previous} keeps running under the new limit`;
    return [lead, `${kept}; nothing was stopped and no new run was started.`, closing].join(" ");
  }
  const relation = input.superseded ? "supersedes" : "takes over from";
  return [
    lead,
    `The same script continues as run ${input.runId}, which ${relation} run ${input.previous} and imports everything run ${input.previous} finished as cache.`,
    closing,
  ].join(" ");
}

/**
 * Clause describing "what changed." The in-place-effect sentence must include its subject ("at most n of **its subagents**") because
 * there is no preceding model clause on that path, so "at most n of them" would have no referent.
 */
function settingsChangeClauses(amend: WorkflowSettingsAmendMeta, inPlace: boolean): string[] {
  const changes: string[] = [];
  const model = amend.subagentModel;
  if (model !== undefined) {
    changes.push(
      model.to === undefined
        ? "its subagents are back on the session model"
        : `its subagents now run on ${model.to}`,
    );
  }
  const bound = amend.maxConcurrency;
  if (bound !== undefined) {
    changes.push(
      bound.to === undefined
        ? "the limit on subagents at once is removed"
        : inPlace
          ? `at most ${bound.to} of its subagents run at once`
          : `at most ${bound.to} of them run at once`,
    );
  }
  return changes;
}

/**
 * The two settings in the snapshot. Both use "absent means default": no model ever specified = session model; a limit at or above the ceiling = no per-run limit.
 * Therefore absence means default, matching {@link RunSettings}.
 */
export function runSettingsOfSnapshot(snapshot: DynamicWorkflowRunSnapshot): RunSettings {
  return {
    ...(snapshot.subagentModel === undefined ? {} : { subagentModel: snapshot.subagentModel }),
    ...(snapshot.maxConcurrency === undefined ? {} : { maxConcurrency: snapshot.maxConcurrency }),
  };
}
