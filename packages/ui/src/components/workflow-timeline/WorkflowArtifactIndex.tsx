import type { CSSProperties } from "react";
import { ArrowUpRightIcon, EllipsisIcon } from "lucide-react";
import {
  ArtifactDetail,
  ArtifactKindIcon,
  artifactDetailText,
  artifactDisplayTitle,
  artifactKindMessageId,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import type { PresetLabels } from "@/app-shell/workflow-artifacts/presets/index.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkflowCompletionArtifact } from "./WorkflowArtifactTile.js";
import { PILL_STAGGER_MS } from "./WorkflowTimeline.js";

/**
 * Artifact index (side pane): **remaining artifacts** after the deliverables row, one per line.
 *
 * There is one rule: **either a preview is readable or it is not rendered**. Deliverables keep their frame; remaining artifacts drop the frame and use only the tile description-row
 * grammar—kind icon, full title, monospace detail (previously hidden in a tooltip on mini tiles), and trailing slot (v{n}, yielding to ↗ on hover)—as a standalone row. Hierarchy comes from **form** (one item with an image vs. the remaining text-only items), rather than large and small frames.
 *
 * Each row is 26px high. Cards flow into two columns with `repeat(auto-fit, minmax(220px, 1fr))` (one column on narrow cards); the side pane always uses one column.
 * A thin line separates this from the deliverables row (`--color-workflow-rule`, the same rule before the four metrics), so the card reads as a three-part receipt:
 * what was delivered, what else happened, and what it cost.
 *
 * “N more” is a doorway, not an artifact: an ellipsis icon, secondary text, and a visible ↗ without hover (following the same rule as the roster's “n more”
 * row); click it to open the run side pane and see everything.
 *
 * Every row is always a `<button>`: when the host provides no callback, it is **disabled** (“what was delivered” is a fact, while “whether it can be opened” is a capability), using the same interaction boundary as pills and tiles. On hover/focus, the whole row fills with `surface-hover` (like a sidebar row), extending 6px beyond the text on each side via negative margins while keeping the text aligned with the deliverable frame.
 *
 * ⚠ Terminology: artifact = an output published to the user by a script through `artifact.*`.
 */
function enterStyle(enterDelayMs: number | undefined): CSSProperties | undefined {
  return enterDelayMs === undefined || enterDelayMs <= 0
    ? undefined
    : { animationDelay: `${enterDelayMs}ms`, animationFillMode: "backwards" };
}

const LINE_CLASS =
  "wf-line wf-arrive -mx-1.5 flex h-[26px] min-w-0 items-center gap-2 rounded-md bg-transparent px-1.5 text-left text-ui-sm outline-none";

function WorkflowArtifactLine({
  artifact,
  enterDelayMs,
  labels,
  onOpen,
  testId = "workflow-artifact-line",
  title: tooltip,
}: {
  artifact: WorkflowCompletionArtifact;
  labels: PresetLabels;
  onOpen?: (artifactId: string) => void;
  enterDelayMs?: number;
  testId?: string;
  /** Tooltip override (the side pane supplies the workspace source); absent means "kind · title". */
  title?: string;
}) {
  const { intl } = useZCodeIntl();
  const title = artifactDisplayTitle(artifact);
  const kindLabel = intl.formatMessage({ id: artifactKindMessageId(artifact.kind) });
  const hasDetail = artifactDetailText(artifact, labels) !== undefined;
  const openable = onOpen !== undefined;
  const version = artifact.version ?? 1;
  const showVersion = version >= 2;

  return (
    <button
      aria-label={
        openable
          ? `${intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.open" })}: ${title}`
          : undefined
      }
      className={cn(LINE_CLASS, openable ? "wf-line-open cursor-pointer" : "cursor-default")}
      data-artifact-id={artifact.id}
      data-artifact-kind={artifact.kind}
      data-artifact-open={openable ? "true" : undefined}
      data-artifact-version={String(version)}
      data-testid={testId}
      data-variant="line"
      disabled={!openable}
      onClick={openable ? () => onOpen(artifact.id) : undefined}
      style={enterStyle(enterDelayMs)}
      title={tooltip ?? `${kindLabel} · ${title}`}
      type="button"
    >
      <ArtifactKindIcon
        className="wf-line-icon size-3.5 shrink-0 text-foreground-subtle"
        kind={artifact.kind}
      />
      <span className="min-w-0 flex-1 truncate text-foreground">{title}</span>
      {hasDetail ? (
        <span
          className="flex shrink-0 items-center gap-1 font-mono text-ui-xs tabular-nums text-foreground-subtlest"
          data-testid="workflow-artifact-line-detail"
        >
          <ArtifactDetail artifact={artifact} labels={labels} />
        </span>
      ) : null}
      {showVersion || openable ? (
        <span className="grid size-3 shrink-0 place-items-center [&>*]:col-start-1 [&>*]:row-start-1">
          {showVersion ? (
            // Remount by version so a republish with the same ID animates the tail slot once (wf-mark entrance); on hover it yields to ↗.
            <span
              className="wf-mark font-mono text-ui-xs leading-none tabular-nums text-foreground-subtlest"
              data-testid="workflow-artifact-tile-version"
              key={version}
              title={intl.formatMessage(
                { id: "chat.toolCall.workflow.run.artifacts.version" },
                { version: String(version) },
              )}
            >
              {intl.formatMessage(
                { id: "chat.toolCall.workflow.run.artifacts.versionTail" },
                { version: String(version) },
              )}
            </span>
          ) : null}
          {openable ? (
            <span
              aria-hidden
              className="wf-pill-go flex items-center justify-center text-foreground-subtlest"
              data-testid="workflow-artifact-tile-open"
            >
              <ArrowUpRightIcon className="size-3" />
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}

/** "N more" is a door, not an artifact. A truncated list has unknown N, so show `…`. */
function WorkflowArtifactMoreLine({
  count,
  enterDelayMs,
  onOpen,
  testId = "workflow-artifact-more-line",
  truncated = false,
}: {
  count: number;
  /** The emitting side truncated the list (over 8), so N is unknown; show `…`. */
  truncated?: boolean;
  onOpen?: () => void;
  enterDelayMs?: number;
  testId?: string;
}) {
  const { intl } = useZCodeIntl();
  const openable = onOpen !== undefined;
  return (
    <button
      className={cn(LINE_CLASS, openable ? "wf-line-open cursor-pointer" : "cursor-default")}
      data-testid={testId}
      data-variant="more"
      disabled={!openable}
      onClick={onOpen}
      style={enterStyle(enterDelayMs)}
      title={intl.formatMessage({ id: "chat.toolCall.workflow.openRunDetails" })}
      type="button"
    >
      <EllipsisIcon aria-hidden className="size-3.5 shrink-0 text-foreground-subtlest" />
      <span className="min-w-0 flex-1 truncate text-foreground-subtle">
        {intl.formatMessage(
          { id: "chat.toolCall.workflow.completion.moreArtifacts" },
          { count: truncated ? "…" : count.toLocaleString() },
        )}
      </span>
      {openable ? (
        // A door has no status marker to replace: ↗ is always visible, not only on hover (wf-pill-go-rest).
        <span className="grid size-3 shrink-0 place-items-center">
          <span
            aria-hidden
            className="wf-pill-go wf-pill-go-rest flex items-center justify-center text-foreground-subtlest"
            data-testid="workflow-artifact-tile-open"
          >
            <ArrowUpRightIcon className="size-3" />
          </span>
        </span>
      ) : null}
    </button>
  );
}

type WorkflowArtifactIndexColumns = "auto" | "one";

/**
 * The index itself: rows + optional door. `columns="auto"` gives cards a two-column flow (requires ≥ 2 × 220px); `"one"` is the side pane's single column.
 * `rule` draws a thin line above (needed after a deliverable row; omit it when the index occupies the card alone). Rows appear in sequence,
 * offset by 30ms from `firstDelayMs`; the door follows the last row.
 */
export function WorkflowArtifactIndex({
  artifacts,
  columns = "auto",
  firstDelayMs = 0,
  folded = 0,
  labels,
  lineTestId,
  more = false,
  moreTestId,
  onOpenArtifact,
  onOpenRun,
  rule = false,
  testId = "workflow-artifact-index",
  tooltipOf,
  truncated = false,
}: {
  artifacts: readonly WorkflowCompletionArtifact[];
  labels: PresetLabels;
  columns?: WorkflowArtifactIndexColumns;
  rule?: boolean;
  /** Render "N more"; `folded` supplies N. */
  more?: boolean;
  folded?: number;
  truncated?: boolean;
  firstDelayMs?: number;
  onOpenArtifact?: (artifactId: string) => void;
  onOpenRun?: () => void;
  testId?: string;
  lineTestId?: string;
  moreTestId?: string;
  tooltipOf?: (artifact: WorkflowCompletionArtifact) => string;
}) {
  return (
    <div
      className={cn(
        "grid gap-x-5",
        columns === "auto" ? "grid-cols-[repeat(auto-fit,minmax(220px,1fr))]" : "grid-cols-1",
        rule && "border-t border-[var(--color-workflow-rule)] pt-1.5",
      )}
      data-columns={columns}
      data-testid={testId}
    >
      {artifacts.map((artifact, index) => (
        <WorkflowArtifactLine
          artifact={artifact}
          enterDelayMs={firstDelayMs + PILL_STAGGER_MS * index}
          key={artifact.id}
          labels={labels}
          {...(lineTestId === undefined ? {} : { testId: lineTestId })}
          {...(tooltipOf === undefined ? {} : { title: tooltipOf(artifact) })}
          {...(onOpenArtifact === undefined ? {} : { onOpen: onOpenArtifact })}
        />
      ))}
      {more ? (
        <WorkflowArtifactMoreLine
          count={folded}
          enterDelayMs={firstDelayMs + PILL_STAGGER_MS * artifacts.length}
          truncated={truncated}
          {...(moreTestId === undefined ? {} : { testId: moreTestId })}
          {...(onOpenRun === undefined ? {} : { onOpen: onOpenRun })}
        />
      ) : null}
    </div>
  );
}
