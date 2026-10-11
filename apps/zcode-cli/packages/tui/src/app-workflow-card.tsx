// Live CreateWorkflow tool card.
//
// Why not use a few detailLines on ToolTranscriptPart: a tool row is a **snapshot at event time**, and
// CreateWorkflow returns as soon as it launches the run, so the tool row becomes completed while the run is still in flight.
// The card must therefore read the mirror at render time (join by toolCallId) and use the run status rather than the tool-row status.
//
// The view is a pure function of props (TUI tests call the component as a function without starting a terminal).
import React from "react";
import type { TuiCopy } from "@zcode/i18n";
import type { WorkflowRunActor } from "@zcode/shared/zcode-protocol-v4";
import { palette } from "./app-model.js";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
import { truncateDisplay } from "./app-terminal-width.js";
import type { TuiWorkflowCard } from "./app-workflow-mirror.js";

const CARD_DETAIL_INDENT = "  ";
const CARD_LOG_INDENT = "    ";
export const MAX_ACTOR_ROWS = 6;
const MAX_RESULT_PREVIEW_WIDTH = 200;

/** Bucket the six rows by status (docs/dynamic-workflow/launch.md, “The inline card”): running rows come first. */
const ACTOR_ROW_RANK: Record<WorkflowRunActor["status"], number> = {
  running: 0,
  waiting: 1,
  completed: 2,
};

/**
 * Actor rows to show on the card.
 *
 * Why not use `actors.slice(0, MAX_ACTOR_ROWS)`: `run.actors` is in protocol order (birth order), and in a wide run the first six
 * actors may already be settled, leaving six completed rows and hiding every active actor. Instead, select by status groups—running → waiting → completed—
 * while preserving protocol order within each group (stable, so an actor moves only when its own status changes).
 */
export function actorRowsForCard(
  actors: readonly WorkflowRunActor[],
  limit: number = MAX_ACTOR_ROWS,
): readonly WorkflowRunActor[] {
  return actors
    .map((actor, index) => ({ actor, index }))
    .sort(
      (left, right) =>
        ACTOR_ROW_RANK[left.actor.status] - ACTOR_ROW_RANK[right.actor.status] ||
        left.index - right.index,
    )
    .slice(0, limit)
    .map((entry) => entry.actor);
}

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

export function WorkflowRunCardView({
  card,
  copy = DEFAULT_TUI_COPY,
  expanded = false,
  terminalWidth = 100,
}: {
  card: TuiWorkflowCard;
  copy?: TuiCopy;
  expanded?: boolean;
  terminalWidth?: number;
}): React.ReactElement {
  const workflowCopy = copy.transcript.workflow;
  const width = Math.max(20, terminalWidth - CARD_DETAIL_INDENT.length);
  const collapsedLine = workflowCopy.collapsed({
    // Only the server knows the label (returned by cold seeding); fall back to runId when absent and never invent a name here.
    label: card.label ?? card.runId,
    status: workflowStatusLabel(card.status, workflowCopy, card.stopReason),
    nodesSettled: card.nodesSettled,
    nodesTotal: card.nodesTotal,
  });
  const hint = expanded ? workflowCopy.collapseHint : workflowCopy.expandHint;

  return h(
    "box",
    {
      style: {
        backgroundColor: "transparent",
        flexDirection: "column",
        marginTop: 1,
        width: "100%",
      },
    },
    h(
      "text",
      { style: { fg: colorForWorkflowStatus(card.status) } },
      truncateDisplay(`${collapsedLine}  [${hint}]`, terminalWidth),
    ),
    ...(expanded ? expandedDetailNodes(card, workflowCopy, width) : []),
  );
}

function expandedDetailNodes(
  card: TuiWorkflowCard,
  workflowCopy: TuiCopy["transcript"]["workflow"],
  width: number,
): React.ReactElement[] {
  const nodes: React.ReactElement[] = [];

  if (card.usage) {
    nodes.push(
      detailLine("usage", workflowCopy.usage({ spentTokens: card.usage.spentTokens }), width),
    );
  }

  if (card.actors.length > 0) {
    nodes.push(detailLine("actors-title", workflowCopy.actors, width));
    for (const [index, actor] of actorRowsForCard(card.actors).entries()) {
      nodes.push(
        h(
          "text",
          { key: `actor-${index}`, style: { fg: palette.muted } },
          truncateDisplay(
            `${CARD_LOG_INDENT}${workflowCopy.actorRow({
              name: actor.name ?? `${actor.siteId}#${actor.ordinal}`,
              status: actor.status,
            })}`,
            width,
          ),
        ),
      );
    }
  }

  if (card.logTail.length > 0) {
    nodes.push(detailLine("log-title", workflowCopy.log, width));
    for (const [index, line] of card.logTail.entries()) {
      nodes.push(
        h(
          "text",
          { key: `log-${index}`, style: { fg: palette.muted } },
          truncateDisplay(`${CARD_LOG_INDENT}${line}`, width),
        ),
      );
    }
  }

  if (card.resultPreview !== undefined) {
    nodes.push(
      detailLine(
        "result",
        workflowCopy.result(truncateDisplay(card.resultPreview, MAX_RESULT_PREVIEW_WIDTH)),
        width,
      ),
    );
  }

  if (card.error !== undefined) {
    nodes.push(
      h(
        "text",
        { key: "error", style: { fg: palette.danger } },
        truncateDisplay(`${CARD_DETAIL_INDENT}${workflowCopy.error(card.error)}`, width),
      ),
    );
  }

  if (card.truncated === true) {
    nodes.push(detailLine("truncated", workflowCopy.truncated, width));
  }

  return nodes;
}

function detailLine(key: string, text: string, width: number): React.ReactElement {
  return h(
    "text",
    { key, style: { fg: palette.muted } },
    truncateDisplay(`${CARD_DETAIL_INDENT}${text}`, width),
  );
}

function workflowStatusLabel(
  status: TuiWorkflowCard["status"],
  workflowCopy: TuiCopy["transcript"]["workflow"],
  stopReason?: TuiWorkflowCard["stopReason"],
): string {
  if (status === "running") return workflowCopy.status.running;
  if (status === "completed") return workflowCopy.status.completed;
  if (status === "errored") return workflowCopy.status.errored;
  // stopped includes the reason: `stopped (model error)`.
  if (status === "stopped") {
    return stopReason === undefined
      ? workflowCopy.status.stopped
      : `${workflowCopy.status.stopped} (${workflowCopy.stopReason[stopReason]})`;
  }
  return workflowCopy.status.pending;
}

function colorForWorkflowStatus(status: TuiWorkflowCard["status"]): string {
  if (status === "completed") return palette.success;
  // errored is a script failure (danger); stopped is recoverable (muted).
  if (status === "errored") return palette.danger;
  if (status === "running") return palette.accent;
  if (status === "stopped") return palette.muted;
  return palette.warning;
}
