import type { ReactNode } from "react";
import { resolvePrimaryArtifact } from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import type { PresetLabels } from "@/app-shell/workflow-artifacts/presets/index.js";
import { WorkflowArtifactIndex } from "./WorkflowArtifactIndex.js";
import { WorkflowArtifactRow } from "./WorkflowArtifactRow.js";
import { ArtifactSheetGlyph, type WorkflowCompletionArtifact } from "./WorkflowArtifactTile.js";
import { PILL_STAGGER_MS } from "./WorkflowTimeline.js";

/**
 * Artifact area of the completion card.
 * Split out of `WorkflowCompletionCard` to keep the card itself under the 400-line limit.
 *
 * - **With a deliverable** (the item marked primary, or the only item in the list): show the deliverable row, then **index** the rest—
 *   one per row, two columns when the card is wide; at most six rows. From item seven onward, show five rows + "N more" (open the run side pane to see all).
 * - **Without a deliverable**: if no item qualifies for a preview, show none; the index uses the entire artifact area with the same limit.
 *
 * Only the deliverable frame reads bytes (either show a readable preview or none); index rows and "N more" never read bytes.
 *
 * ⚠ Terminology: artifact = output published for the user by a script through `artifact.*`.
 */

/** Maximum number of index rows on the card, including the uncollapsed state. */
export const COMPLETION_INDEX_MAX = 6;
/** Number of rows shown alongside "N more" when that row is needed. */
const COMPLETION_INDEX_WITH_MORE = COMPLETION_INDEX_MAX - 1;

export interface CompletionArtifactLayout {
  /** Deliverable; absent means the index uses the whole area. */
  primary?: WorkflowCompletionArtifact;
  /** Items to render as rows (excluding the deliverable). */
  lines: readonly WorkflowCompletionArtifact[];
  /** Number of items not rendered (the N in "N more"). */
  folded: number;
  /** Render "N more" when items are folded or the emitting side truncated the list (N is unknown in that case; show `…`). */
  more: boolean;
}

/** **Sole** layout decision; card (animation timing), fetch gate (which items read bytes), and rendering all use this result. */
export function completionArtifactLayout(
  artifacts: readonly WorkflowCompletionArtifact[],
  truncated: boolean,
): CompletionArtifactLayout {
  if (artifacts.length === 0) return { lines: [], folded: 0, more: false };
  const primary = resolvePrimaryArtifact(artifacts);
  const rest = primary === undefined ? artifacts : artifacts.filter((a) => a !== primary);
  // A truncated list (over 8) has an unknown true count; still show the entry and use `…` for N, matching the artifact strip's honest ellipsis.
  const more = rest.length > COMPLETION_INDEX_MAX || truncated;
  const lines = rest.slice(0, more ? COMPLETION_INDEX_WITH_MORE : COMPLETION_INDEX_MAX);
  return {
    ...(primary === undefined ? {} : { primary }),
    lines,
    folded: rest.length - lines.length,
    more,
  };
}

/** Number of card cells rendered (deliverable row, each index row, and "N more" each count as one); the four metric cells animate afterward. */
export function completionArtifactCellCount(layout: CompletionArtifactLayout): number {
  return (layout.primary === undefined ? 0 : 1) + layout.lines.length + (layout.more ? 1 : 0);
}

/** Items that read bytes: only the deliverable frame reads; index rows and the entry do not. */
export function completionPreviewIds(layout: CompletionArtifactLayout): ReadonlySet<string> {
  return new Set(layout.primary === undefined ? [] : [layout.primary.id]);
}

export function WorkflowCompletionArtifacts({
  artifactsTruncated,
  labels,
  layout,
  onOpenArtifact,
  onOpenRun,
  renderPreview,
}: {
  layout: CompletionArtifactLayout;
  artifactsTruncated: boolean;
  labels: PresetLabels;
  renderPreview?: (artifact: WorkflowCompletionArtifact) => ReactNode;
  onOpenArtifact?: (artifactId: string) => void;
  onOpenRun?: () => void;
}) {
  const { primary, lines, folded, more } = layout;
  if (primary === undefined && lines.length === 0 && !more) return null;
  const hasPrimary = primary !== undefined;
  return (
    <>
      {hasPrimary ? (
        <WorkflowArtifactRow
          artifact={primary}
          enterDelayMs={PILL_STAGGER_MS}
          labels={labels}
          preview={renderPreview?.(primary) ?? <ArtifactSheetGlyph />}
          testId="workflow-completion-row"
          {...(onOpenArtifact === undefined ? {} : { onOpen: onOpenArtifact })}
        />
      ) : null}
      {lines.length > 0 || more ? (
        // Separate the index from the deliverable row with a thin line; omit it when the index occupies the artifact area alone.
        <WorkflowArtifactIndex
          artifacts={lines}
          columns="auto"
          firstDelayMs={PILL_STAGGER_MS * (hasPrimary ? 2 : 1)}
          folded={folded}
          labels={labels}
          lineTestId="workflow-completion-line"
          more={more}
          moreTestId="workflow-completion-more"
          rule={hasPrimary}
          testId="workflow-completion-index"
          truncated={artifactsTruncated}
          {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
          {...(onOpenRun === undefined ? {} : { onOpenRun })}
        />
      ) : null}
    </>
  );
}
