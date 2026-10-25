// ============================================================
// GUI “Configure” settings turn: what to record and how to report it.
// ============================================================
// docs/dynamic-workflow/launch.md, “The settings turn.” Split from dynamic-workflow-run-settings.ts
// (400-line limit): that file owns decision and side-effect order; this one owns how to describe the change to the model and session—queueing,
// the from/to values for both settings, and the two canonical sentences (amendment created a new run / in-place update kept the same run).

import type { TraceContext, WorkflowSettingsAmendMeta } from "@zcode/contracts";
import type { DynamicWorkflowRunSnapshot } from "@zcode/contracts";
import { uuidv7 } from "@zcode/shared";
import { createRuntimeCommandId } from "../command-queue.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { boundWorkflowLaunchMeta } from "@zcode/contracts";

/** Normalized form of this run's two settings: absent means default (session model / default concurrency). */
export interface RunSettings {
  subagentModel?: string;
  maxConcurrency?: number;
}

/**
 * Do not execute a settings turn directly in command handling: the main agent may be mid-turn, and a user message cannot be inserted.
 * Queue it in runtime; run immediately when idle or wait for the current turn to finish when busy. It has the same priority as notifications,
 * so it runs before any notification for a new run (docs/dynamic-workflow/launch.md, “The settings turn”).
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
        ? "the limit on subagents at once is back to the default"
        : inPlace
          ? `at most ${bound.to} of its subagents run at once`
          : `at most ${bound.to} of them run at once`,
    );
  }
  return changes;
}

/**
 * The two settings from the snapshot. Both are absent when default: no selected model means the session model; a limit equal to default concurrency means no per-run limit,
 * so absence means default, matching {@link RunSettings}.
 */
export function runSettingsOfSnapshot(snapshot: DynamicWorkflowRunSnapshot): RunSettings {
  return {
    ...(snapshot.subagentModel === undefined ? {} : { subagentModel: snapshot.subagentModel }),
    ...(snapshot.maxConcurrency === undefined ? {} : { maxConcurrency: snapshot.maxConcurrency }),
  };
}
