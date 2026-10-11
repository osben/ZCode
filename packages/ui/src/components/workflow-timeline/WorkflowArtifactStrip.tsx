import type { KeyboardEvent, MouseEvent } from "react";
import { ARTIFACT_CHIP_MAX_VISIBLE } from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PILL_STAGGER_MS } from "./WorkflowTimeline.js";
import {
  WorkflowArtifactPill,
  type ArtifactPillData,
  type ArtifactPillSize,
} from "./WorkflowArtifactPill.js";

/**
 * Artifact strip: one row of up to three artifact pills,
 * with the rest folded into a fixed-width `+N`. Used below the timeline (tool cards/end-of-turn summaries), in collapsed completion notices,
 * in the hub's run-history rows, and in "Recent artifacts"; the same artifact must look the same in all four places. The full list is in the run side pane.
 *
 * ⚠ Terminology: artifact = output published for the user by a script through `artifact.*`.
 *
 * Stop event propagation only for the **pills**: the strip often sits inside another clickable region (completion-notice collapse control,
 * end-of-turn summary toggle, or hub history row). A pill is a button, not part of that outer region—**even when disabled**.
 * Disabled means opening is a no-op; it must not also open the outer region (browsers do not dispatch clicks on disabled controls, but jsdom bubbles to ancestors;
 * keep behavior consistent in both). Blank strip space and `+N` **are** part of the outer region: let their clicks bubble so the end-of-turn summary toggles.
 */
function hitsPill(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button") !== null;
}

export function WorkflowArtifactStrip({
  artifacts,
  className,
  moreTestId,
  onOpenArtifact,
  pillTestId,
  size = "md",
  testId,
  truncated = false,
  variant = "pill",
}: {
  variant?: "pill" | "link";
  artifacts: readonly ArtifactPillData[];
  size?: ArtifactPillSize;
  /** Absent means all pills are disabled (callback presence is the gate). */
  onOpenArtifact?: (artifactId: string) => void;
  /** The emitting side truncated the list (limit exceeded or items filtered), so `+N` may undercount; use `…` instead of a number. */
  truncated?: boolean;
  testId?: string;
  pillTestId?: string;
  moreTestId?: string;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  if (artifacts.length === 0) return null;
  const visible = artifacts.slice(0, ARTIFACT_CHIP_MAX_VISIBLE);
  const overflow = artifacts.length - visible.length;
  return (
    <span
      className={cn(
        "wf-motion flex min-w-0 shrink flex-wrap items-center",
        size === "md" ? "gap-1.5" : "gap-1",
        className,
      )}
      data-testid={testId}
      onClick={(event: MouseEvent<HTMLSpanElement>) => {
        if (hitsPill(event.target)) event.stopPropagation();
      }}
      onKeyDown={(event: KeyboardEvent<HTMLSpanElement>) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (hitsPill(event.target)) event.stopPropagation();
      }}
    >
      {visible.map((artifact, i) => (
        <WorkflowArtifactPill
          artifact={artifact}
          variant={variant}
          enterDelayMs={PILL_STAGGER_MS * i}
          key={artifact.id}
          size={size}
          truncateTitle
          {...(pillTestId === undefined ? {} : { testId: pillTestId })}
          {...(onOpenArtifact === undefined ? {} : { onOpen: onOpenArtifact })}
        />
      ))}
      {overflow > 0 || truncated ? (
        <span
          className="shrink-0 px-0.5 font-mono text-ui-xs tabular-nums text-foreground-subtlest"
          data-testid={moreTestId}
        >
          {intl.formatMessage(
            { id: "chat.backgroundResult.workflow.artifacts.more" },
            { count: truncated && overflow === 0 ? "…" : String(overflow) },
          )}
        </span>
      ) : null}
    </span>
  );
}
