import type { ReactNode } from "react";
import { ChartLineIcon, FileIcon, GaugeIcon, SquareKanbanIcon, TableIcon } from "lucide-react";
import type { WorkflowRunArtifactKind } from "@zcode/shared/zcode-protocol-v4";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import type {
  ArtifactPresetKind,
  PresetLabels,
} from "@/app-shell/workflow-artifacts/presets/index.js";

/**
 * Shared presentation rules for user-facing artifacts across **several surfaces** (run side-panel tiles, completion-card tiles, `workflow-artifact` tab, notification-row pills, and hub).
 *
 * ⚠ Terminology: artifact here means output the script publishes to users through `artifact.*`, not the engine's
 * top-level script return value, which has a similar name.
 *
 * There is one reason to extract this: **the same artifact must look the same across all four surfaces**. If icons or kind labels are defined separately,
 * the chip in a notification row and the tab it opens will eventually use different icons for the same thing.
 */

/** Four preset board types. Content types (file / markdown) have bytes and versions; these do not. */
const PRESET_KINDS = new Set<WorkflowRunArtifactKind>(["chart", "table", "metrics", "board"]);

export function isArtifactPresetKind(kind: WorkflowRunArtifactKind): kind is ArtifactPresetKind {
  return PRESET_KINDS.has(kind);
}

/** Message id for the kind label. One label for each of the six types (file / document / chart / table / metric / board). */
export function artifactKindMessageId(kind: WorkflowRunArtifactKind): string {
  return `chat.toolCall.workflow.run.artifacts.kind.${kind}`;
}

const MARKDOWN_ICON = resolveFileDisplayDescriptor("artifact.md").fileIconSrc;
const KIND_ICON: Record<Exclude<WorkflowRunArtifactKind, "markdown">, typeof FileIcon> = {
  file: FileIcon,
  chart: ChartLineIcon,
  table: TableIcon,
  metrics: GaugeIcon,
  board: SquareKanbanIcon,
};

/**
 * Icon for the kind. The caller supplies its size through `className` (card size-4, chip size-3.5, tab header size-4)—
 * sizing depends on surface density, not on the icon itself.
 */
export function ArtifactKindIcon({
  kind,
  className,
}: {
  kind: WorkflowRunArtifactKind;
  className?: string;
}): ReactNode {
  if (kind === "markdown") {
    return <FileDisplayIcon src={MARKDOWN_ICON} className={className} />;
  }
  const Icon = KIND_ICON[kind];
  return <Icon aria-hidden="true" className={className} />;
}

/**
 * Display formatting for byte counts.
 *
 * Deliberately define this locally instead of importing the same-named function from `feedback/feedbackSubmissionJob.ts`:
 * that module handles feedback-upload jobs, and pulling the entire upload dependency graph into app-shell for five lines of arithmetic is not worthwhile.
 * Drift between the two has no impact (one reports file size, the other reports bytes sent).
 */
export function formatArtifactBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Whether the body for this contentType is **human-readable text**—the gate for the "Copy" action.
 *
 * `application/json` is listed separately because IANA classifies it under application/, but when a script delivers
 * `artifact.file("summary", "out/report.json")`, users want to copy its contents. This differs from `textLanguageFor`, which dispatches the body
 * to a code viewer; this function decides only whether the entire body can be copied.
 */
export function isTextArtifactContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  return contentType.startsWith("text/") || contentType === "application/json";
}

/** File-type badge: prefer the extension from the original workspace path (`out/book.pdf` → `PDF`), falling back to the MIME subtype when there is no path. */
export function artifactFileBadge(artifact: {
  sourcePath?: string;
  contentType?: string;
}): string | undefined {
  const extension = artifact.sourcePath?.match(/\.([a-z0-9]{1,5})$/iu)?.[1];
  if (extension !== undefined) return extension.toUpperCase();
  const subtype = artifact.contentType?.split("/")[1]?.split(";")[0]?.trim();
  if (subtype === undefined || subtype.length === 0) return undefined;
  const KNOWN: Record<string, string> = {
    "x-markdown": "MD",
    markdown: "MD",
    plain: "TXT",
    json: "JSON",
    csv: "CSV",
    html: "HTML",
    pdf: "PDF",
  };
  return KNOWN[subtype] ?? (subtype.length <= 5 ? subtype.toUpperCase() : undefined);
}

/**
 * Monospaced detail for pill/tile captions: file `PDF · 4.0 KB`, document size only, preset board count of input rows
 * (its "size" is data volume; omit the count when unknown). Shared by side-panel tiles and completion cards—if defined twice, one will eventually
 * show a badge that the other omits. A null result means the caller should not render the detail slot.
 */
export function ArtifactDetail({
  artifact,
  labels,
}: {
  artifact: {
    kind: WorkflowRunArtifactKind;
    bytes?: number;
    itemCount?: number;
    sourcePath?: string;
    contentType?: string;
  };
  labels: PresetLabels;
}): ReactNode {
  if (isArtifactPresetKind(artifact.kind)) {
    return artifact.itemCount === undefined ? null : (
      <span data-testid="workflow-run-artifact-items">{labels.itemsCount(artifact.itemCount)}</span>
    );
  }
  if (artifact.bytes === undefined) return null;
  const badge = artifact.kind === "file" ? artifactFileBadge(artifact) : undefined;
  return (
    <>
      {badge === undefined ? null : (
        <>
          <span data-testid="workflow-run-artifact-badge">{badge}</span>
          <span aria-hidden>·</span>
        </>
      )}
      <span data-testid="workflow-run-artifact-bytes">{formatArtifactBytes(artifact.bytes)}</span>
    </>
  );
}

/**
 * **Plain-text** formatting for caption details (`PDF · 4.0 KB` / `4 items`): compact tiles move details into the tooltip,
 * while deliverable rows put them in the `kind · size` line. Same rules as `ArtifactDetail`, but without a testid.
 */
export function artifactDetailText(
  artifact: {
    kind: WorkflowRunArtifactKind;
    bytes?: number;
    itemCount?: number;
    sourcePath?: string;
    contentType?: string;
  },
  labels: PresetLabels,
): string | undefined {
  if (isArtifactPresetKind(artifact.kind)) {
    return artifact.itemCount === undefined ? undefined : labels.itemsCount(artifact.itemCount);
  }
  if (artifact.bytes === undefined) return undefined;
  const badge = artifact.kind === "file" ? artifactFileBadge(artifact) : undefined;
  const size = formatArtifactBytes(artifact.bytes);
  return badge === undefined ? size : `${badge} · ${size}`;
}

/**
 * Deliverable: the item marked `primary`; if there is no flag and the list
 * has only one item, that item is the deliverable—**the single-item rule exists only in the UI**; protocol and engine never infer the flag. In all other cases
 * there is no deliverable: a failed primary is not replaced by another artifact, and lists with multiple unflagged items use the current layout.
 */
export function resolvePrimaryArtifact<T extends { primary?: true }>(
  artifacts: readonly T[],
): T | undefined {
  const flagged = artifacts.find((artifact) => artifact.primary === true);
  if (flagged !== undefined) return flagged;
  return artifacts.length === 1 ? artifacts[0] : undefined;
}

/**
 * Put the deliverable first and preserve the order of the rest. The CLI's three projections (journal → port, notification manifest, GetWorkflowRun) already
 * use this order; this is the only sorting point for the **live projection path** (`workflowRuns[].artifacts` upserted in publish order).
 */
export function orderArtifactsPrimaryFirst<T extends { primary?: true }>(
  artifacts: readonly T[],
): T[] {
  const index = artifacts.findIndex((artifact) => artifact.primary === true);
  if (index <= 0) return [...artifacts];
  return [artifacts[index]!, ...artifacts.slice(0, index), ...artifacts.slice(index + 1)];
}

/** Card title: prefer the author's title; if absent, fall back to id (the facade's default title is already the id). */
export function artifactDisplayTitle(artifact: { id: string; title?: string }): string {
  return artifact.title?.trim() || artifact.id;
}

/** Title truncation length for chips. */
const ARTIFACT_CHIP_TITLE_MAX_LENGTH = 24;

/** Maximum chips shown inline in notification/hub rows; fold the rest into "+N". */
export const ARTIFACT_CHIP_MAX_VISIBLE = 3;

export function truncateArtifactChipTitle(title: string): string {
  return title.length > ARTIFACT_CHIP_TITLE_MAX_LENGTH
    ? `${title.slice(0, ARTIFACT_CHIP_TITLE_MAX_LENGTH)}…`
    : title;
}

/**
 * Three translated labels passed to the four preset renderers. Renderers do not look up i18n themselves (they are reused by side panels/tabs/hub),
 * so each surface creates its own labels in its intl context.
 */
export function buildPresetLabels(
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string,
): PresetLabels {
  return {
    otherColumn: formatMessage({
      id: "chat.toolCall.workflow.run.artifacts.preset.otherColumn",
    }),
    empty: formatMessage({ id: "chat.toolCall.workflow.run.artifacts.preset.empty" }),
    itemsCount: (count: number) =>
      formatMessage(
        { id: "chat.toolCall.workflow.run.artifacts.preset.items" },
        { count: String(count) },
      ),
  };
}

/**
 * Whether this artifact can be located on the **local filesystem** (the gate for "Show in Workspace" and the HTML "Open in Browser" action).
 *
 * Uses the same criterion as `shouldOpenAssistantHtmlInBrowser`: paths in remote workspaces (SSH / WSL / Docker)
 * do not exist locally, and mobile remote control has no file tree to navigate. If `sourcePath` is absent, there is no path at all—
 * Markdown artifacts and preset boards have no source path by design.
 */
export function canRevealArtifactInWorkspace(params: {
  sourcePath?: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}): boolean {
  return (
    Boolean(params.sourcePath?.trim()) &&
    !params.workspaceIdentity?.trim() &&
    !params.remoteSessionId
  );
}

/**
 * Filename for the “Open as file” copy. `markdown` is always `<id>.md` (`id` is restricted to `[A-Za-z0-9_.-]`);
 * `file` uses the basename of this version’s `sourcePath`—the extension determines which app the system opens, and the same id can
 * come from different paths in different versions. Fall back to the id when the source is unavailable.
 */
export function artifactOpenAsFileName(
  artifact: {
    id: string;
    kind: WorkflowRunArtifactKind;
    version: number;
    sourcePath?: string;
    versions?: readonly { version: number; sourcePath?: string }[];
  },
  version: number,
): string {
  if (artifact.kind === "markdown") return `${artifact.id}.md`;
  const sourcePath =
    artifact.versions?.find((entry) => entry.version === version)?.sourcePath ??
    (version === artifact.version ? artifact.sourcePath : undefined);
  const leaf = sourcePath?.split(/[\\/]/u).at(-1)?.trim();
  return leaf ? leaf : artifact.id;
}
