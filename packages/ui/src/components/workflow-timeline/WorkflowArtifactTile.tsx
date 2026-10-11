import type { CSSProperties, ReactNode } from "react";
import { ArrowUpRightIcon } from "lucide-react";
import {
  ArtifactKindIcon,
  artifactDisplayTitle,
  artifactKindMessageId,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ArtifactPillData } from "./WorkflowArtifactPill.js";

/**
 * Artifact tile: one artifact = preview area + details row.
 * The details row reuses the artifact pill's exact grammar (square kind tile, title, monospaced details, version tail slot, hover ↗ replacement).
 * The preview area is a thumbnail of the artifact **itself**—a scaled rendering of a document's first page, the first CSV rows, or the board—
 * supplied by the caller according to kind. When it cannot be supplied (PDF/binary/bytes not yet available), render a quiet page glyph.
 *
 * A pill is an artifact in a row; a tile is used when there is room. It is currently shown only in the run side pane's gallery
 * when there are **no deliverables** (130–180px per column, large enough to read). When deliverables exist, other artifacts use the index row
 * (`WorkflowArtifactIndex`): show a preview only when it is readable. The old mini-tile (small six-column boxes) was removed because it was not readable.
 *
 * ⚠ Terminology: artifact = an output that a script publishes to the user through `artifact.*`.
 *
 * The entire tile is always a `<button>`. When the host supplies no callback, it is **disabled** (what was delivered is a fact; whether it can be opened is a capability), using the same gate as the pill.
 *
 * The preview frame used to be a child of the button, but Markdown thumbnails may have their own controls (table "Copy Markdown", file links),
 * creating a `<button>` inside a `<button>` and a React DOM nesting error. The preview frame is now a **sibling** of the button and marked `inert`
 * (it is a thumbnail, not interactive, and excluded from the accessibility tree). The button wraps only the details row and a full-tile `::after`
 * (`.wf-tile-hit`) receives clicks, hover, and focus; `.wf-tile:has(.wf-tile-hit:hover)` lifts the frame on hover.
 */
export interface WorkflowCompletionArtifact extends ArtifactPillData {
  contentType?: string;
  bytes?: number;
  sourcePath?: string;
  /** Number of entries supplied by the preloaded board; absent from notification payloads and available only after live projection/journal enrichment. */
  itemCount?: number;
  /** Spec for the preloaded board (only the journal can provide it); used to render the preview. */
  spec?: unknown;
  /** One or two author-written description sentences; shown only on the deliverable row because the tile has no room. */
  description?: string;
  /** Deliverables from the run. */
  primary?: true;
}

/** Page glyph for unavailable content: a small sheet with an extension badge in the lower-right corner. Keep it plain and honest. */
export function ArtifactSheetGlyph({ badge }: { badge?: string }) {
  return (
    <div className="absolute inset-0 grid place-items-center" data-testid="workflow-artifact-sheet">
      <div className="flex aspect-[3/4] w-[38%] max-w-[72px] flex-col gap-1.5 rounded-[4px] border border-border bg-card p-2.5 shadow-[0_1px_0_var(--color-workflow-rule)]">
        <i className="block h-[5px] w-[55%] rounded-sm bg-surface-hover" />
        <i className="block h-[3px] rounded-sm bg-surface-hover" />
        <i className="block h-[3px] rounded-sm bg-surface-hover" />
        <i className="block h-[3px] w-[70%] rounded-sm bg-surface-hover" />
      </div>
      {badge === undefined ? null : (
        <span
          className="absolute bottom-2 right-2 rounded-[4px] bg-surface-hover px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle"
          data-testid="workflow-artifact-sheet-badge"
        >
          {badge}
        </span>
      )}
    </div>
  );
}

export function WorkflowArtifactTile({
  artifact,
  detail,
  enterDelayMs,
  onOpen,
  preview,
  testId = "workflow-artifact-tile",
  title: tooltip,
}: {
  artifact: WorkflowCompletionArtifact;
  /** Preview-area content; absent means the page glyph. */
  preview?: ReactNode;
  /** Monospaced metadata after the name and before the tail slot (`CSV · 6 KB` / `4 items`). */
  detail?: ReactNode;
  onOpen?: (artifactId: string) => void;
  enterDelayMs?: number;
  testId?: string;
  /** Tooltip override (the side pane supplies the workspace source); absent means "kind · title". */
  title?: string;
}) {
  const { intl } = useZCodeIntl();
  const title = artifactDisplayTitle(artifact);
  const kindLabel = intl.formatMessage({ id: artifactKindMessageId(artifact.kind) });
  const openable = onOpen !== undefined;
  const version = artifact.version ?? 1;
  const showVersion = version >= 2;
  const style: CSSProperties | undefined =
    enterDelayMs === undefined || enterDelayMs <= 0
      ? undefined
      : { animationDelay: `${enterDelayMs}ms`, animationFillMode: "backwards" };

  return (
    <div className="wf-tile relative flex min-w-0 flex-col gap-1.5" data-variant="tile">
      {/* Preview frame: the preview content decides whether to fade at the bottom (document thumbnails should suggest there is more; boards and images should not). */}
      <div
        aria-hidden
        className="wf-tile-frame wf-arrive relative aspect-[16/10] w-full overflow-hidden rounded-lg border border-border bg-panel"
        data-testid="workflow-artifact-tile-frame"
        inert
        style={style}
      >
        {preview ?? <ArtifactSheetGlyph />}
      </div>
      <button
        aria-label={
          openable
            ? `${intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.open" })}: ${title}`
            : undefined
        }
        className={cn(
          "wf-tile-hit wf-arrive flex min-w-0 items-center gap-1.5 rounded-lg bg-transparent p-0 px-0.5 text-left text-ui-sm outline-none",
          openable ? "wf-tile-open cursor-pointer" : "cursor-default",
        )}
        data-artifact-id={artifact.id}
        data-artifact-kind={artifact.kind}
        data-artifact-open={openable ? "true" : undefined}
        data-artifact-version={String(version)}
        data-testid={testId}
        data-variant="tile"
        disabled={!openable}
        onClick={openable ? () => onOpen(artifact.id) : undefined}
        style={style}
        title={tooltip ?? `${kindLabel} · ${title}`}
        type="button"
      >
        <ArtifactKindIcon className="size-4 shrink-0 text-foreground-subtle" kind={artifact.kind} />
        <span className="wf-pill-name min-w-0 flex-1 truncate text-foreground">{title}</span>
        {detail === undefined || detail === null ? null : (
          <span
            className="flex shrink-0 items-center gap-1 font-mono text-ui-xs tabular-nums text-foreground-subtlest"
            data-testid="workflow-artifact-tile-detail"
          >
            {detail}
          </span>
        )}
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
    </div>
  );
}
