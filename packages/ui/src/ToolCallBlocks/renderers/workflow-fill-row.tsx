import { useMemo, type ReactNode } from "react";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { draftTimeline, scanWorkflowDraft } from "@/components/workflow-timeline/draft-scan.js";
import { narrowTimelineToFill } from "@/components/workflow-timeline/timeline-holes.js";
import {
  buildWorkflowTimeline,
  type WorkflowTimelineModel,
} from "@/components/workflow-timeline/timeline-model.js";
import { readWorkflowDisplay } from "@/ToolCallBlocks/renderers/createWorkflowDisplay.js";
import {
  readWorkflowHoleTarget,
  type WorkflowHoleTarget,
} from "@/ToolCallBlocks/renderers/createWorkflowHoleInput.js";
import type { WorkflowKindVocabulary } from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import { isFillWorkflowHoleToolCall } from "@/lib/workflowToolNames.js";

/**
 * The fill-row slice of the create-workflow renderer (docs/dynamic-workflow/presentation.md "The fill row").
 * Split out of create-workflow.tsx (max-lines gate): the same renderer with the hole vocabulary; the primary
 * text is the hole's name (from the display's `fill` block — the row's input has no name); the draft phase
 * line is the segment of the parent track where the fill sits (new sites in full ink, adjacent sites ghost).
 */
export function useWorkflowHoleRow(
  toolCall: {
    toolName?: string | null;
    kind?: string | null;
    title?: string | null;
    raw?: unknown;
    input?: unknown;
  },
  amend: boolean,
): {
  fill: boolean;
  holeTarget: WorkflowHoleTarget | undefined;
  vocabulary: WorkflowKindVocabulary;
} {
  const fill = isFillWorkflowHoleToolCall(toolCall);
  const holeTarget = useMemo(
    () =>
      fill
        ? readWorkflowHoleTarget(toolCall.input, readWorkflowDisplay(toolCall.raw)?.fill)
        : undefined,
    [fill, toolCall.input, toolCall.raw],
  );
  return { fill, holeTarget, vocabulary: fill ? "hole" : amend };
}

/** Timeline model for the card: from the graph when present (fill rows narrow to the fill's segment), from draft scanning while streaming, none otherwise. */
export function useWorkflowCardModel({
  graph,
  holeTarget,
  run,
  scriptText,
  writing,
}: {
  graph: WorkflowCausalityGraphData | undefined;
  run: WorkflowRunState | undefined;
  holeTarget: WorkflowHoleTarget | undefined;
  scriptText: string | undefined;
  writing: boolean;
}): WorkflowTimelineModel | undefined {
  return useMemo(() => {
    if (graph !== undefined) {
      // Fill row: narrow the valid script's graph to the segment containing the fill (adjacent sites ghost); the name comes from the tool-backfilled input.
      if (holeTarget?.holeId !== undefined) {
        const labels = new Map(
          holeTarget.name === undefined ? [] : [[holeTarget.holeId, { name: holeTarget.name }]],
        );
        const whole = buildWorkflowTimeline(graph, undefined, labels);
        return narrowTimelineToFill(whole, holeTarget.holeId) ?? whole;
      }
      return buildWorkflowTimeline(graph, run);
    }
    // Streaming draft: the display has not arrived yet, so sites are scanned from the partial script; the whole model is replaced once the display arrives.
    if (writing && scriptText !== undefined) return draftTimeline(scanWorkflowDraft(scriptText));
    return undefined;
  }, [graph, holeTarget, run, scriptText, writing]);
}

/**
 * Primary text for pre-launch / feedback rows. ToolLayout is a memo component: nodes handed to it must be
 * reference-stable. Fill rows show `· <hole name>`; the rest show the name only. The hole's kind is not rendered.
 */
export function useWorkflowRowPrimaryText(fill: boolean, name: string): ReactNode {
  return useMemo(
    () =>
      fill ? (
        <span className="inline-flex min-w-0 items-center gap-2 text-foreground-subtlest">
          <span aria-hidden>·</span>
          <span className="truncate" data-testid="workflow-fill-hole-name">
            {name}
          </span>
        </span>
      ) : (
        <span className="truncate text-foreground-subtlest">{name}</span>
      ),
    [fill, name],
  );
}
