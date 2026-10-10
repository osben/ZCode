import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { buildPresetLabels } from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { workDurationParts, workDurationUnitSeparator } from "@/lib/workDuration.js";
import type { WorkflowCompletionArtifact } from "./WorkflowArtifactTile.js";
import {
  WORKFLOW_RUN_KIND_ID,
  WorkflowCardHeader,
  WorkflowRunStatus,
} from "./WorkflowCardChrome.js";
import {
  completionArtifactCellCount,
  completionArtifactLayout,
  WorkflowCompletionArtifacts,
} from "./WorkflowCompletionArtifacts.js";
import { PILL_STAGGER_MS } from "./WorkflowTimeline.js";

export { COMPLETION_INDEX_MAX } from "./WorkflowCompletionArtifacts.js";

/**
 * Completion card: at the end of the turn where the main agent consumes a **completed** workflow notification,
 * show this card. The order makes the point: header → **what this run delivered** (deliverable row) → **what else it did** (artifact index,
 * one item per row) → **what it cost** (four metrics). Separate each section with a thin line like a receipt. Artifact area is in `WorkflowCompletionArtifacts`.
 *
 * Display only: the host supplies the artifact list, four metrics, and each artifact preview (the host is responsible for reading preview bytes).
 * No chevron because nothing expands; the card is not a toggle.
 *
 * Keep metrics honest: use `—` for unavailable values, not 0.
 */
export interface WorkflowCompletionFigures {
  durationMs?: number;
  tokens?: number;
  subagents?: number;
  /** Number of phases entered (`run.phases`); use `—` when a script has no phase() markers. */
  phases?: number;
}

export interface WorkflowCompletionCardProps {
  name: string;
  figures: WorkflowCompletionFigures;
  artifacts: readonly WorkflowCompletionArtifact[];
  /** The emitting side truncated the list; show `…` for N in "N more". */
  artifactsTruncated?: boolean;
  /** Preview for a rendered frame (only the deliverable row has one); absent/undefined means render the page glyph. */
  renderPreview?: (artifact: WorkflowCompletionArtifact) => ReactNode;
  onOpenRun?: () => void;
  onOpenArtifact?: (artifactId: string) => void;
  testIdKey: string;
}

/** Duration of the number-count-up animation; all four cells animate together, following the staggered pills in the strip. */
const COUNT_UP_MS = 640;

/**
 * Compact token formatting: `812` / `386.4k` / `1.30M`. Use one decimal for thousands and two for millions so all four
 * monospaced metric cells align across runs. Put the full value in the title.
 */
export function formatCompactCount(count: number): { value: string; unit: string } {
  if (count < 1_000) return { value: count.toLocaleString(), unit: "" };
  if (count < 1_000_000) return { value: (count / 1_000).toFixed(1), unit: "k" };
  return { value: (count / 1_000_000).toFixed(2), unit: "M" };
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/** Animate numbers only when the browser **explicitly** says reduced motion is off; if unavailable (static rendering/jsdom), show the final value. */
function motionAllowed(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: no-preference)").matches
  );
}

/**
 * Count from 0 to the target. **The first frame is the target value** (static rendering, tests, and reduced-motion all see the final value);
 * only after mount does it return to 0 and count up, keeping the page complete at rest.
 */
function useCountUp(target: number | undefined): number | undefined {
  const [shown, setShown] = useState(target);
  useEffect(() => {
    if (target === undefined || !motionAllowed() || typeof requestAnimationFrame !== "function") {
      setShown(target);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / COUNT_UP_MS);
      setShown(Math.round(target * easeOutCubic(progress)));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    setShown(0);
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return shown;
}

function Figure({
  delayMs,
  label,
  parts,
  testKey,
  title,
}: {
  testKey: string;
  label: string;
  /** Alternating `[number, unit]`; absent means `—`. */
  parts: readonly { value: string; unit: string }[] | undefined;
  title?: string;
  delayMs: number;
}) {
  const { intl } = useZCodeIntl();
  const unavailable = intl.formatMessage({ id: "chat.toolCall.workflow.completion.unavailable" });
  const style: CSSProperties = { animationDelay: `${delayMs}ms`, animationFillMode: "backwards" };
  return (
    <div
      className="wf-arrive flex min-w-0 flex-col"
      data-testid={`workflow-completion-figure-${testKey}`}
      data-value={
        parts === undefined ? undefined : parts.map((part) => part.value + part.unit).join(" ")
      }
      style={style}
    >
      <span
        aria-label={parts === undefined ? unavailable : undefined}
        className={cn(
          "whitespace-nowrap font-mono text-ui-lg leading-tight tabular-nums",
          parts === undefined ? "text-foreground-subtlest" : "font-medium text-foreground",
        )}
        title={title}
      >
        {parts === undefined
          ? "—"
          : parts.map((part, index) => (
              <span key={index}>
                {index > 0 ? " " : null}
                {part.value}
                {part.unit.length === 0 ? null : (
                  <span className="text-ui-sm font-normal text-foreground-subtle">{part.unit}</span>
                )}
              </span>
            ))}
      </span>
      <span className="truncate text-ui-sm text-foreground-subtle">{label}</span>
    </div>
  );
}

export function WorkflowCompletionCard({
  artifacts,
  artifactsTruncated = false,
  figures,
  name,
  onOpenArtifact,
  onOpenRun,
  renderPreview,
  testIdKey,
}: WorkflowCompletionCardProps) {
  const { intl, locale } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const labels = useMemo(
    () => buildPresetLabels((descriptor, values) => intl.formatMessage(descriptor, values)),
    [intl],
  );

  const layout = useMemo(
    () => completionArtifactLayout(artifacts, artifactsTruncated),
    [artifacts, artifactsTruncated],
  );

  // Count up the four metrics; duration counts milliseconds, then formats them as "11m 48s".
  const durationMs = useCountUp(figures.durationMs);
  const tokens = useCountUp(figures.tokens);
  const subagents = useCountUp(figures.subagents);
  const phases = useCountUp(figures.phases);
  const separator = workDurationUnitSeparator(locale);
  const timeParts =
    durationMs === undefined
      ? undefined
      : workDurationParts(durationMs, format).map((part) => ({
          value: String(part.value),
          unit: `${separator}${part.unit}`,
        }));
  const tokenParts = tokens === undefined ? undefined : [formatCompactCount(tokens)];
  const plain = (value: number | undefined) =>
    value === undefined ? undefined : [{ value: value.toLocaleString(), unit: "" }];

  const figureDelay = PILL_STAGGER_MS * (completionArtifactCellCount(layout) + 1);

  return (
    <section
      aria-label={format({ id: WORKFLOW_RUN_KIND_ID.completed })}
      className="wf-motion wf-arrive flex w-full min-w-0 flex-col gap-2.5 rounded-xl border border-border/70 bg-card/70 px-3.5 pb-3 pt-1.5"
      data-testid={`workflow-completion-card-${testIdKey}`}
      data-workflow-completion-card="true"
    >
      <WorkflowCardHeader
        expanded={false}
        kind={format({ id: WORKFLOW_RUN_KIND_ID.completed })}
        name={name}
        status={<WorkflowRunStatus status="completed" testId="workflow-completion-status" />}
        {...(onOpenRun === undefined ? {} : { onOpenDetails: onOpenRun })}
      />
      <WorkflowCompletionArtifacts
        artifactsTruncated={artifactsTruncated}
        labels={labels}
        layout={layout}
        {...(renderPreview === undefined ? {} : { renderPreview })}
        {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
        {...(onOpenRun === undefined ? {} : { onOpenRun })}
      />
      <div
        className="grid grid-cols-4 gap-x-3 border-t border-[var(--color-workflow-rule)] pt-2.5"
        data-testid="workflow-completion-figures"
      >
        <Figure
          delayMs={figureDelay}
          label={format({ id: "chat.toolCall.workflow.completion.time" })}
          parts={timeParts}
          testKey="time"
        />
        <Figure
          delayMs={figureDelay + PILL_STAGGER_MS}
          label={format({ id: "chat.toolCall.workflow.completion.tokens" })}
          parts={tokenParts}
          testKey="tokens"
          {...(figures.tokens === undefined
            ? {}
            : {
                title: format(
                  { id: "chat.toolCall.workflow.card.tokens" },
                  { count: figures.tokens.toLocaleString() },
                ),
              })}
        />
        <Figure
          delayMs={figureDelay + PILL_STAGGER_MS * 2}
          label={format({ id: "chat.toolCall.workflow.completion.subagents" })}
          parts={plain(subagents)}
          testKey="subagents"
        />
        <Figure
          delayMs={figureDelay + PILL_STAGGER_MS * 3}
          label={format({ id: "chat.toolCall.workflow.completion.phases" })}
          parts={plain(phases)}
          testKey="phases"
        />
      </div>
    </section>
  );
}
