import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
} from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";
import type {
  PullRequestStage,
  SessionPullRequest,
  SessionPullRequestHealth,
  SessionPullRequestReviewDecision,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";

/**
 * Shared pull request indicator (specs/sidebar-pr-status.md): the Lucide glyph
 * encodes the lifecycle stage, the dot encodes the health of open/draft PRs.
 * Every surface (row, hover, menu, header chip, Git tools, Session manager)
 * reuses this component so glyph, color, and dot semantics stay identical.
 */

const STAGE_ICON: Record<PullRequestStage, LucideIcon> = {
  draft: GitPullRequestDraft,
  open: GitPullRequest,
  merged: GitMerge,
  closed: GitPullRequestClosed,
};

const STAGE_TEXT_CLASS: Record<PullRequestStage, string> = {
  draft: "text-pr-draft",
  open: "text-pr-open",
  merged: "text-pr-merged",
  closed: "text-pr-closed",
};

/**
 * Row variant hides the dot on passing PRs (the green glyph already says
 * "healthy open PR", spec scenario 1); the detail variant keeps the success
 * dot for Git tools and the hover card.
 */
export function pullRequestHealthDotClass(
  health: SessionPullRequestHealth,
  variant: "row" | "detail",
): string | null {
  if (health === "conflict" || health === "failing") {
    return "bg-destructive";
  }
  if (health === "optional_failing" || health === "running") {
    return "bg-warning";
  }
  if (health === "passing" && variant === "detail") {
    return "bg-success";
  }
  return null;
}

export interface PullRequestIntl {
  formatMessage(descriptor: { id: string }, values?: Record<string, string>): string;
}

export function pullRequestStageMessageId(stage: PullRequestStage): string {
  if (stage === "draft") return "pullRequest.stageDraft";
  if (stage === "open") return "pullRequest.stageOpen";
  if (stage === "merged") return "pullRequest.stageMerged";
  return "pullRequest.stageClosed";
}

/** Health text for tooltips, aria labels, and the Git tools column; null = no text. */
export function formatPullRequestHealthText(
  intl: PullRequestIntl,
  health: SessionPullRequestHealth,
  failingCheckCount: number,
): string | null {
  if (health === "conflict") {
    return intl.formatMessage({ id: "pullRequest.conflict" });
  }
  if (health === "failing") {
    return intl.formatMessage(
      { id: "pullRequest.checksFailing" },
      { count: String(failingCheckCount) },
    );
  }
  if (health === "optional_failing") {
    return intl.formatMessage(
      { id: "pullRequest.checksOptionalFailing" },
      { count: String(failingCheckCount) },
    );
  }
  if (health === "running") {
    return intl.formatMessage({ id: "pullRequest.checksRunning" });
  }
  return null;
}

export function pullRequestReviewMessageId(decision: SessionPullRequestReviewDecision): string {
  if (decision === "approved") return "pullRequest.approved";
  if (decision === "changes_requested") return "pullRequest.changesRequested";
  return "pullRequest.reviewRequired";
}

/** Highest failing-check count among the open/draft pull requests; drives the "{count} failing" label. */
export function maxOpenDraftFailingCheckCount(pullRequests: readonly SessionPullRequest[]): number {
  let maximum = 0;
  for (const pullRequest of pullRequests) {
    if (pullRequest.stage === "open" || pullRequest.stage === "draft") {
      maximum = Math.max(maximum, pullRequest.failingCheckCount);
    }
  }
  return maximum;
}

/**
 * Accessible-label parts for the primary pull request ("PR #N", stage, health
 * text). Callers join with " · " and append the stale note where applicable,
 * so every surface announces the same sequence.
 */
export function pullRequestLabelParts(
  intl: PullRequestIntl,
  primary: SessionPullRequest,
  health: SessionPullRequestHealth,
  failingCheckCount: number,
): string[] {
  return [
    intl.formatMessage({ id: "pullRequest.prLabel" }, { number: String(primary.number) }),
    intl.formatMessage({ id: pullRequestStageMessageId(primary.stage) }),
    formatPullRequestHealthText(intl, health, failingCheckCount),
  ].filter((part): part is string => part !== null);
}

export function PullRequestStatusIcon({
  stage,
  health = "none",
  dotVariant = "none",
  label,
  className,
  iconClassName,
  ...rest
}: {
  stage: PullRequestStage;
  health?: SessionPullRequestHealth;
  /** "row" hides the success dot, "detail" keeps it, "none" renders the glyph only. */
  dotVariant?: "row" | "detail" | "none";
  /** Full accessible label ("PR #N · Stage" plus health text); also becomes the tooltip. */
  label?: string;
  className?: string;
  iconClassName?: string;
} & ComponentPropsWithoutRef<"span">) {
  const Icon = STAGE_ICON[stage];
  const dotClass = dotVariant === "none" ? null : pullRequestHealthDotClass(health, dotVariant);
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-0.5", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      title={label}
      {...rest}
    >
      <Icon className={cn(STAGE_TEXT_CLASS[stage], iconClassName ?? "size-3.5")} />
      {dotClass ? <span className={cn("size-1.5 shrink-0 rounded-full", dotClass)} /> : null}
    </span>
  );
}
