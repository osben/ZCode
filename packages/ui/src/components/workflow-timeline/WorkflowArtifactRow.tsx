import type { CSSProperties, ReactNode } from "react";
import { ArrowUpRightIcon } from "lucide-react";
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

/**
 * Deliverable row (side pane): how a run's primary artifact appears in completion cards and run side panes.
 *
 * It is a **sideways tile**: the same 16:10 preview frame (160 × 100, matching the tile rather than a banner), with a kind icon beside it,
 * a title one size larger than the details row, author-written description (truncated to three lines), a monospaced `kind · size` line,
 * and the tile's tail slot (v{n}, yielding to ↗ on hover). Emphasis comes from placement, shape, and text—not a larger preview or any label;
 * the UI never uses the word "primary".
 *
 * When the panel is narrower than 380px, the frame shrinks to 136 × 85 (container query `wf-artifacts`, declared by the side-pane body).
 * Completion cards do not declare a container, so they always use 160 × 100.
 *
 * The entire row is a `<button>`; without a host callback it is disabled, using the same gate as the tile.
 * It shares the tile structure (see the `WorkflowArtifactTile` file header): the preview frame is a sibling of the button and marked `inert`,
 * the button wraps only the text column, and a full-row `::after` receives clicks. Tail slot and metadata reuse the tile test IDs
 * (`workflow-artifact-tile-version` / `-open`, `workflow-run-artifact-badge` / `-bytes` / `-items`); they use the same grammar, so tests can find the version regardless of layout.
 */
export function WorkflowArtifactRow({
  artifact,
  enterDelayMs,
  labels,
  onOpen,
  preview,
  testId = "workflow-artifact-row",
  title: tooltip,
}: {
  artifact: WorkflowCompletionArtifact;
  labels: PresetLabels;
  /** Preview-frame content; absent means the page glyph supplied by the caller as `ArtifactSheetGlyph`, matching the tile. */
  preview?: ReactNode;
  onOpen?: (artifactId: string) => void;
  enterDelayMs?: number;
  testId?: string;
  /** Tooltip override (the side pane adds the workspace source); absent means "kind · title". */
  title?: string;
}) {
  const { intl } = useZCodeIntl();
  const title = artifactDisplayTitle(artifact);
  const kindLabel = intl.formatMessage({ id: artifactKindMessageId(artifact.kind) });
  const hasDetail = artifactDetailText(artifact, labels) !== undefined;
  const description = artifact.description?.trim();
  const openable = onOpen !== undefined;
  const version = artifact.version ?? 1;
  const showVersion = version >= 2;
  const style: CSSProperties | undefined =
    enterDelayMs === undefined || enterDelayMs <= 0
      ? undefined
      : { animationDelay: `${enterDelayMs}ms`, animationFillMode: "backwards" };

  return (
    <div
      className="wf-tile relative grid w-full min-w-0 grid-cols-[160px_minmax(0,1fr)] items-start gap-3 @max-[380px]/wf-artifacts:grid-cols-[136px_minmax(0,1fr)]"
      data-variant="row"
    >
      <div
        aria-hidden
        className="wf-tile-frame wf-arrive relative h-[100px] w-[160px] overflow-hidden rounded-lg border border-border bg-panel @max-[380px]/wf-artifacts:h-[85px] @max-[380px]/wf-artifacts:w-[136px]"
        data-testid="workflow-artifact-row-frame"
        inert
        style={style}
      >
        {preview}
      </div>
      <button
        aria-label={
          openable
            ? `${intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.open" })}: ${title}`
            : undefined
        }
        className={cn(
          "wf-tile-hit wf-arrive flex min-w-0 flex-col gap-0.5 rounded-lg bg-transparent p-0 pt-px text-left outline-none",
          openable ? "wf-tile-open cursor-pointer" : "cursor-default",
        )}
        data-artifact-id={artifact.id}
        data-artifact-kind={artifact.kind}
        data-artifact-open={openable ? "true" : undefined}
        data-artifact-version={String(version)}
        data-testid={testId}
        data-variant="row"
        disabled={!openable}
        onClick={openable ? () => onOpen(artifact.id) : undefined}
        style={style}
        title={tooltip ?? `${kindLabel} · ${title}`}
        type="button"
      >
        <span className="flex h-5 min-w-0 items-center gap-1.5">
          <ArtifactKindIcon
            className="size-4 shrink-0 text-foreground-subtle"
            kind={artifact.kind}
          />
          <span
            className="wf-pill-name min-w-0 flex-1 truncate text-ui-base font-medium text-foreground"
            data-testid="workflow-artifact-row-title"
          >
            {title}
          </span>
          {showVersion || openable ? (
            <span className="grid size-3 shrink-0 place-items-center [&>*]:col-start-1 [&>*]:row-start-1">
              {showVersion ? (
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
        </span>
        {description === undefined || description.length === 0 ? null : (
          // If the author supplied no description, omit this line but keep the row; do not substitute an ID or placeholder sentence.
          <span
            className="line-clamp-3 text-ui-sm text-foreground-subtle [text-wrap:pretty]"
            data-testid="workflow-artifact-row-description"
          >
            {description}
          </span>
        )}
        <span
          className="mt-0.5 flex h-4 min-w-0 items-center gap-1.5 font-mono text-ui-xs tabular-nums text-foreground-subtlest"
          data-testid="workflow-artifact-row-detail"
        >
          <span>{kindLabel}</span>
          {hasDetail ? (
            <>
              <span aria-hidden>·</span>
              <span className="flex min-w-0 items-center gap-1 truncate">
                <ArtifactDetail artifact={artifact} labels={labels} />
              </span>
            </>
          ) : null}
        </span>
      </button>
    </div>
  );
}
