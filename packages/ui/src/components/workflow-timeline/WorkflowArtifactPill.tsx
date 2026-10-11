import type { CSSProperties, ReactNode } from "react";
import { ArrowUpRightIcon } from "lucide-react";
import type { WorkflowRunArtifactKind } from "@zcode/shared/zcode-protocol-v4";
import {
  ArtifactKindIcon,
  artifactDisplayTitle,
  artifactKindMessageId,
  truncateArtifactChipTitle,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * Artifact pill: uses the same visual grammar as the subagent pill—
 * same height, radius, background, hover lift, and ↗ replacing the tail-slot content on hover—with two changes: a **square** ink-gray tile instead of
 * a **round** colored avatar (color says "who", shape says "what"), and a version number rather than a status marker in the tail slot.
 *
 * ⚠ Terminology: artifact here means an output that a script publishes for the user through `artifact.*`, not the engine's internal "top-level script return value" with the same name.
 *
 * Two sizes: `md` (32px) for existing pill locations (artifact strips below the timeline and the hub's "Recent artifacts");
 * `sm` (24px) for single rows (collapsed completion-notice headers and run-history rows in the hub). When an artifact **has room** (completion card,
 * run side-pane gallery), use a tile (`WorkflowArtifactTile`) whose details row follows this pill's grammar.
 *
 * Always a `<button>`: an artifact is something that can be opened. Without a host callback it is a **disabled** button, quiet like a subagent pill
 * with no session—what was delivered is a fact; whether it can be opened is a capability. Show version numbers only from v2 onward (v1 is the norm and adds noise);
 * when the same ID is republished, remount the tail slot by version and play the marker entrance animation.
 */
export interface ArtifactPillData {
  id: string;
  kind: WorkflowRunArtifactKind;
  title?: string;
  version?: number;
}

export type ArtifactPillSize = "md" | "sm";

export function WorkflowArtifactPill({
  artifact,
  className,
  detail,
  enterDelayMs,
  fill = false,
  onOpen,
  size = "md",
  testId = "workflow-artifact-pill",
  title,
  truncateTitle = false,
  variant = "pill",
}: {
  variant?: "pill" | "link";
  artifact: ArtifactPillData;
  size?: ArtifactPillSize;
  /** Monospaced metadata after the name and before the tail slot (for example, `PDF · 1.2 MB` / `12 items` in sidebar rows). */
  detail?: ReactNode;
  /** Present means it can be opened; absent means disabled (the callback's presence is the gate). */
  onOpen?: (artifactId: string) => void;
  /** Name fills the remaining width (sidebar row); absent means the pill shrinks to content (artifact strip below the timeline). */
  fill?: boolean;
  /** Truncate the title in a strip to 24 characters (full title remains in tooltip); sidebar rows use CSS truncate instead. */
  truncateTitle?: boolean;
  /** Tooltip override; absent means "kind · title". */
  title?: string;
  /** Entrance delay (pills in an artifact strip arrive one by one, offset by 30 ms). */
  enterDelayMs?: number;
  testId?: string;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const fullTitle = artifactDisplayTitle(artifact);
  const label = truncateTitle ? truncateArtifactChipTitle(fullTitle) : fullTitle;
  const kindLabel = intl.formatMessage({ id: artifactKindMessageId(artifact.kind) });
  const openable = onOpen !== undefined;
  const version = artifact.version ?? 1;
  const showVersion = version >= 2;
  const versionLabel = intl.formatMessage(
    { id: "chat.toolCall.workflow.run.artifacts.version" },
    { version: String(version) },
  );
  const md = size === "md";
  // Delayed entrances need backwards fill to keep the start frame during the wait (same reason as the subagent pill).
  const style: CSSProperties | undefined =
    enterDelayMs === undefined || enterDelayMs <= 0
      ? undefined
      : { animationDelay: `${enterDelayMs}ms`, animationFillMode: "backwards" };

  // Notification summaries reuse the Read-link grammar to avoid a bulky artifact pill in tool rows.
  if (variant === "link")
    return (
      <button
        type="button"
        disabled={!openable}
        onClick={openable ? () => onOpen(artifact.id) : undefined}
        data-testid={testId}
        data-artifact-id={artifact.id}
        data-artifact-kind={artifact.kind}
        data-artifact-version={String(version)}
        title={title ?? `${kindLabel} · ${fullTitle}`}
        className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-ui-base font-normal text-foreground-subtle enabled:cursor-pointer enabled:hover:underline"
      >
        <ArtifactKindIcon className="size-4 shrink-0" kind={artifact.kind} />
        <span className="min-w-0 truncate">{label}</span>
        {showVersion ? (
          <span data-testid="workflow-run-artifact-version">{versionLabel}</span>
        ) : null}
      </button>
    );
  return (
    <button
      aria-label={
        openable
          ? `${intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.open" })}: ${fullTitle}`
          : undefined
      }
      className={cn(
        "wf-pill wf-arrive flex min-w-0 max-w-full items-center bg-surface text-left",
        md
          ? "h-8 gap-2 rounded-[9px] pl-2 pr-2.5 text-ui-sm"
          : "h-6 gap-1.5 rounded-md pl-1.5 pr-2 text-ui-xs",
        openable
          ? "wf-pill-open cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          : "cursor-default",
        fill && "w-full",
        className,
      )}
      data-artifact-id={artifact.id}
      data-artifact-kind={artifact.kind}
      data-artifact-open={openable ? "true" : undefined}
      data-artifact-version={String(version)}
      data-pill-size={size}
      data-testid={testId}
      disabled={!openable}
      onClick={openable ? () => onOpen(artifact.id) : undefined}
      style={style}
      title={title ?? `${kindLabel} · ${fullTitle}`}
      type="button"
    >
      <ArtifactKindIcon className="size-4 shrink-0 text-foreground-subtle" kind={artifact.kind} />
      <span className={cn("wf-pill-name min-w-0 truncate text-foreground", fill && "flex-1")}>
        {label}
      </span>
      {detail === undefined || detail === null ? null : (
        <span className="flex shrink-0 items-center gap-1 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
          {detail}
        </span>
      )}
      {showVersion || openable ? (
        <span
          className={cn(
            "wf-pill-tail grid shrink-0 place-items-center [&>*]:col-start-1 [&>*]:row-start-1",
            md ? "size-3.5" : "size-3",
          )}
          data-testid="workflow-pill-tail"
        >
          {showVersion ? (
            // Remount by version so a republish with the same ID animates the tail slot once (wf-mark entrance); on hover it yields to ↗.
            <span
              className="wf-mark font-mono text-ui-xs leading-none tabular-nums text-foreground-subtlest"
              data-testid="workflow-run-artifact-version"
              key={version}
              title={versionLabel}
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
              data-testid="workflow-artifact-pill-open"
            >
              <ArrowUpRightIcon className={md ? "size-3.5" : "size-3"} />
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}
