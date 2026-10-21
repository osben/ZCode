import { Cpu, FileDiff, GitBranch } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { SessionPullRequest, SessionPullRequestStatus, ZCodeTaskMeta } from "@zcode/shared";
import { worstSessionPullRequestHealth } from "@zcode/shared";
import { TooltipContent } from "@/components/ui/tooltip.js";
import { IncognitoTaskMarker } from "@/components/IncognitoTaskMarker.js";
import { WorktreeTaskMarker } from "@/components/WorktreeTaskMarker.js";
import {
  PullRequestStatusIcon,
  formatPullRequestHealthText,
  pullRequestReviewMessageId,
  pullRequestStageMessageId,
} from "@/components/PullRequestStatusIcon.js";
import { thoughtLevelLabelId } from "@/chat-input-toolbar/thoughtLevelOptions.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { useTaskPullRequestStatus } from "@/hooks/useTaskPullRequestStatus.js";
import { selectPrimarySessionPullRequest } from "@/store/pullRequestStatusStore.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { getTaskChangeSummary } from "@/lib/taskChangeSummary.js";
import { providerBrandIconSrc } from "@/lib/oauthProviderIcon.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { formatGroupedTaskHoverChangeParts } from "@/project-sidebar/grouped/task-row-tooltip.js";
import type { TaskListRowActivity } from "@/v4/taskListRowActivity.js";

/**
 * Sidebar task hover card (specs/task-hover-card-layout.md): three detail lines under the row —
 * title + worktree marker + relative time, branch + change stats, provider + model + thought
 * level, then the session's pull requests (specs/sidebar-pr-status.md). The sidebar row owns
 * run-state signaling; the card keeps only the resolved status as a probe attribute.
 */
export function TaskSidebarHoverCard({
  task,
  attentionLabel,
  activity,
  intl,
}: {
  task: ZCodeTaskMeta;
  attentionLabel: string | null;
  activity: TaskListRowActivity | null;
  intl: Pick<IntlInstance, "formatMessage">;
}) {
  const status = resolveStatus(task, activity, attentionLabel, intl);
  const modelAndEffort = resolveModelAndEffort(task, intl);
  const changeParts = formatGroupedTaskHoverChangeParts(getTaskChangeSummary(task));
  const branchLabel = task.executionWorktree?.branchName;
  const lastActivity = activity?.lastActivityAt ?? task.updatedAt;
  const pullRequestStatus = useTaskPullRequestStatus(task);
  const taskTitle =
    task.title ||
    intl.formatMessage({
      id: task.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
    });

  return (
    <TooltipContent
      side="right"
      align="center"
      sideOffset={6}
      className="w-80 max-w-[calc(100vw-1rem)] flex-col items-stretch gap-2.5 p-3"
    >
      <div
        data-task-hover-card="true"
        data-task-hover-status={status?.kind}
        className="flex min-w-0 flex-col gap-2.5"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-ui-base text-foreground">{taskTitle}</span>
          {task.executionWorktree ? <WorktreeTaskMarker task={task} /> : null}
          {task.incognito ? <IncognitoTaskMarker task={task} /> : null}
          <span className="ml-auto shrink-0 text-foreground-subtle">
            {formatTaskRelativeTime(lastActivity, intl)}
          </span>
        </div>

        {branchLabel ? (
          <InfoRow icon={<RowGlyph icon={GitBranch} />}>
            <span className="truncate">{branchLabel}</span>
            {changeParts.length > 0 ? (
              <ChangeStats className="ml-auto" parts={changeParts} />
            ) : null}
          </InfoRow>
        ) : changeParts.length > 0 ? (
          // No branch source: keep the diff facts visible on their own line instead of dropping them.
          <InfoRow icon={<RowGlyph icon={FileDiff} />}>
            <ChangeStats parts={changeParts} />
          </InfoRow>
        ) : null}

        {modelAndEffort ? (
          <InfoRow
            icon={
              providerBrandIconSrc(modelAndEffort.providerId) ? (
                <img
                  src={providerBrandIconSrc(modelAndEffort.providerId) ?? ""}
                  alt=""
                  aria-hidden="true"
                  className="size-4 shrink-0 object-contain"
                />
              ) : (
                <RowGlyph icon={Cpu} />
              )
            }
          >
            {modelAndEffort.model ? (
              <span className="min-w-0 truncate">{modelAndEffort.model}</span>
            ) : null}
            {modelAndEffort.effort ? (
              <span className="shrink-0 text-foreground-subtle">{modelAndEffort.effort}</span>
            ) : null}
          </InfoRow>
        ) : null}

        <PullRequestHoverSection task={task} status={pullRequestStatus} intl={intl} />
      </div>
    </TooltipContent>
  );
}

const PULL_REQUEST_HOVER_MAX_LINES = 3;

function PullRequestHoverSection({
  task,
  status,
  intl,
}: {
  task: ZCodeTaskMeta;
  status: SessionPullRequestStatus | undefined;
  intl: Pick<IntlInstance, "formatMessage">;
}) {
  if (!task.executionWorktree) {
    return null;
  }
  if (
    status?.state === "unavailable" &&
    (status.unavailableReason === "no_gh" || status.unavailableReason === "auth")
  ) {
    // The feature must never fail silently: worktree sessions show one muted
    // line when gh is missing or unauthenticated (spec scope rule 3).
    return (
      <div data-task-hover-pr="unavailable" className="text-ui-sm text-foreground-subtlest">
        {intl.formatMessage({
          id:
            status.unavailableReason === "no_gh"
              ? "pullRequest.unavailableNoGh"
              : "pullRequest.unavailableAuth",
        })}
      </div>
    );
  }
  if (!status || status.pullRequests.length === 0) {
    return null;
  }
  const visible = status.pullRequests.slice(0, PULL_REQUEST_HOVER_MAX_LINES);
  const overflowCount = status.pullRequests.length - visible.length;
  const primary = selectPrimarySessionPullRequest(status);
  return (
    <div data-task-hover-pr="list" className="flex min-w-0 flex-col gap-1.5">
      {visible.map((pullRequest) => (
        <PullRequestHoverLine
          key={`${pullRequest.repository}#${pullRequest.number}`}
          pullRequest={pullRequest}
          intl={intl}
        />
      ))}
      {overflowCount > 0 ? (
        <div className="text-ui-sm text-foreground-subtlest">
          {intl.formatMessage({ id: "pullRequest.moreCount" }, { count: String(overflowCount) })}
        </div>
      ) : null}
      {primary?.reviewDecision ? (
        <div className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: pullRequestReviewMessageId(primary.reviewDecision) })}
        </div>
      ) : null}
      {status.stale ? (
        <div className="text-ui-sm text-foreground-subtlest">
          {intl.formatMessage({ id: "pullRequest.stale" })}
        </div>
      ) : null}
    </div>
  );
}

function PullRequestHoverLine({
  pullRequest,
  intl,
}: {
  pullRequest: SessionPullRequest;
  intl: Pick<IntlInstance, "formatMessage">;
}) {
  const health = worstSessionPullRequestHealth([pullRequest]);
  const healthText = formatPullRequestHealthText(intl, health, pullRequest.failingCheckCount);
  return (
    <div className="flex min-w-0 items-center gap-2 text-ui-base">
      <PullRequestStatusIcon
        stage={pullRequest.stage}
        health={health}
        dotVariant="detail"
        iconClassName="size-4"
      />
      <span className="min-w-0 truncate">
        {`#${pullRequest.number}`} ·{" "}
        {intl.formatMessage({ id: pullRequestStageMessageId(pullRequest.stage) })}
      </span>
      {healthText ? (
        <span className="ml-auto shrink-0 text-foreground-subtle">{healthText}</span>
      ) : null}
    </div>
  );
}

function InfoRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-ui-base">
      {icon}
      {children}
    </div>
  );
}

function RowGlyph({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon aria-hidden="true" className="size-4 shrink-0 text-foreground-subtle" />;
}

function ChangeStats({ parts, className }: { parts: string[]; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 ${className ?? ""}`}>
      {parts.map((part) => (
        <span key={part} className={part.startsWith("+") ? "text-diff-added" : "text-diff-removed"}>
          {part}
        </span>
      ))}
    </span>
  );
}

function resolveStatus(
  task: ZCodeTaskMeta,
  activity: TaskListRowActivity | null,
  attentionLabel: string | null,
  intl: Pick<IntlInstance, "formatMessage">,
): { kind: string; label: string; className: string } | null {
  if (attentionLabel) {
    return {
      kind: "attention",
      label: attentionLabel,
      className: "w-fit rounded-md bg-warning/10 px-2 py-1 text-ui-sm text-warning",
    };
  }

  const phase = activity?.phase;
  if (phase === "prewarming" || phase === "running") {
    return {
      kind: "running",
      label: intl.formatMessage({ id: "taskList.status.streaming" }),
      className: "w-fit rounded-md bg-selected px-2 py-1 text-ui-sm text-foreground",
    };
  }
  if (phase === "error" || (!activity && task.status === "error")) {
    return {
      kind: "failed",
      label: intl.formatMessage({ id: "taskList.status.failed" }),
      className: "w-fit rounded-md bg-destructive/10 px-2 py-1 text-ui-sm text-destructive",
    };
  }
  if (
    phase === "completedSuccess" ||
    phase === "completedInterrupted" ||
    (!activity && task.status === "completed")
  ) {
    return {
      kind: "completed",
      label: intl.formatMessage({ id: "taskList.status.completed" }),
      className: "w-fit rounded-md bg-surface-hover px-2 py-1 text-ui-sm text-foreground",
    };
  }

  return {
    kind: "ready",
    label: intl.formatMessage({ id: "taskList.status.ready" }),
    className: "w-fit rounded-md bg-surface-hover px-2 py-1 text-ui-sm text-foreground",
  };
}

function resolveModelAndEffort(task: ZCodeTaskMeta, intl: Pick<IntlInstance, "formatMessage">) {
  const modelSelection = task.model ? parseTaskModelForDisplay(task.model) : null;
  const model = modelSelection?.modelId ?? "";
  const modelEffort = modelSelection?.reasoningLevel;
  const effort = task.thoughtLevel ?? modelEffort;
  const effortLabelId = effort ? thoughtLevelLabelId(effort) : undefined;
  if (!model && !effort) {
    return null;
  }
  return {
    providerId: modelSelection?.providerId,
    model: model || null,
    effort: effort ? (effortLabelId ? intl.formatMessage({ id: effortLabelId }) : effort) : null,
  };
}

function parseTaskModelForDisplay(value: string) {
  try {
    const selection = parseModelPickerValue(value);
    return {
      providerId: selection.providerId,
      modelId: selection.modelId,
      reasoningLevel: selection.options?.reasoningLevel,
    };
  } catch {
    // Historical task meta may store an older format; when displaying, derive the model name from
    // provider/model without blocking sidebar rendering.
    const [model = "", reasoningLevel] = value.split("$", 2);
    return {
      providerId: undefined,
      modelId: model.slice(model.lastIndexOf("/") + 1),
      reasoningLevel,
    };
  }
}
