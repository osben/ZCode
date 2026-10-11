import { Cpu, FileDiff, Folder, GitBranch, GitMerge, Cloud } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { GitBranchMergeStatus, ZCodeTaskMeta } from "@zcode/shared";
import { TooltipContent } from "@/components/ui/tooltip.js";
import { thoughtLevelLabelId } from "@/chat-input-toolbar/thoughtLevelOptions.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { getTaskChangeSummary } from "@/lib/taskChangeSummary.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { formatGroupedTaskHoverChangeParts } from "@/workspace-grouped-tasks/task-row-tooltip.js";
import type { TaskListRowActivity } from "@/v4/taskListRowActivity.js";

export function TaskSidebarHoverCard({
  task,
  workspaceLabel,
  attentionLabel,
  activity,
  branchMergeStatus,
  isRemote = false,
}: {
  task: ZCodeTaskMeta;
  workspaceLabel: string;
  attentionLabel: string | null;
  activity: TaskListRowActivity | null;
  branchMergeStatus?: GitBranchMergeStatus;
  isRemote?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const status = resolveStatus(task, activity, attentionLabel, intl);
  const modelAndEffort = resolveModelAndEffort(task, intl);
  const changeParts = formatGroupedTaskHoverChangeParts(getTaskChangeSummary(task));
  const isBranchMerged = branchMergeStatus?.state === "merged";
  const lastActivity = activity?.lastActivityAt ?? task.updatedAt;

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
        <div className="flex items-center justify-between gap-3">
          {status ? <span className={status.className}>{status.label}</span> : <span />}
          <span className="shrink-0 text-foreground-subtle">
            {formatTaskRelativeTime(lastActivity, intl)}
          </span>
        </div>

        <InfoRow icon={isRemote ? Cloud : Folder}>
          <span className="truncate">{workspaceLabel}</span>
        </InfoRow>

        {isBranchMerged || branchMergeStatus?.headRef ? (
          <InfoRow icon={isBranchMerged ? GitMerge : GitBranch}>
            {isBranchMerged ? (
              <span className="text-primary">
                {intl.formatMessage({ id: "taskList.branchMergedTag" })}
              </span>
            ) : (
              <span className="truncate">{branchMergeStatus.headRef}</span>
            )}
            {isBranchMerged && changeParts.length > 0 ? (
              <ChangeStats className="ml-auto" parts={changeParts} />
            ) : null}
          </InfoRow>
        ) : null}

        {modelAndEffort ? (
          <InfoRow icon={Cpu}>
            {modelAndEffort.model ? (
              <span className="min-w-0 truncate">{modelAndEffort.model}</span>
            ) : null}
            {modelAndEffort.effort ? (
              <span className="shrink-0 text-foreground-subtle">{modelAndEffort.effort}</span>
            ) : null}
          </InfoRow>
        ) : null}

        {!isBranchMerged && changeParts.length > 0 ? (
          <InfoRow icon={FileDiff}>
            <ChangeStats parts={changeParts} />
          </InfoRow>
        ) : null}

        {/* TODO: Show PR number/status once task metadata has a trustworthy source. */}
      </div>
    </TooltipContent>
  );
}

function InfoRow({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-ui-base">
      <Icon aria-hidden="true" className="size-4 shrink-0 text-foreground-subtle" />
      {children}
    </div>
  );
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
    model: model || null,
    effort: effort ? (effortLabelId ? intl.formatMessage({ id: effortLabelId }) : effort) : null,
  };
}

function parseTaskModelForDisplay(value: string) {
  try {
    const selection = parseModelPickerValue(value);
    return {
      modelId: selection.modelId,
      reasoningLevel: selection.options?.reasoningLevel,
    };
  } catch {
    // 历史 task meta 可能保存了旧格式；展示时从 provider/model 中取模型名，不阻断侧栏渲染。
    const [model = "", reasoningLevel] = value.split("$", 2);
    return {
      modelId: model.slice(model.lastIndexOf("/") + 1),
      reasoningLevel,
    };
  }
}
