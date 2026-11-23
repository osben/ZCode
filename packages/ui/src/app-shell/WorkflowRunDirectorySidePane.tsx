import { stationLampClass } from "@/components/workflow-timeline/WorkflowTimelineLedge.js";
import { memo, useEffect, useMemo, useState } from "react";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { WorkflowAgentFace } from "@/components/workflow-timeline/WorkflowAgentFace.js";
import { cn } from "@/components/lib/utils.js";
import {
  RUN_STATUS_TEXT,
  readWorkflowRunStopReason,
  workflowRunStopReasonMessageId,
} from "@/components/workflow-graph/run-status-presentation.js";
import { useWorkflowRunJournalSummaries } from "@/hooks/useWorkflowRunJournalSummaries.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  OpenScopedWorkflowRunSideTabRequest,
  WorkflowRunDirectorySidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { V4PaneConversationProvider, useV4Conversation } from "@/v4/V4ConversationContext.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import {
  WORKFLOW_RUN_DIRECTORY_LIMIT,
  buildWorkflowRunDirectory,
  workflowRunDirectoryRefreshKey,
  type WorkflowRunDirectoryRow,
} from "@/v4/workflowRunDirectoryModel.js";

/**
 * Workflow run directory for a conversation. Its three-step shape exactly mirrors the subagent directory: task-list footer row → this page → `workflow-run`
 * detail page.
 *
 * **Rows render only journal summaries**: the discovery query already returns `pending`/
 * `running`, so both are available; live run steps and duration appear in the task list (above the row you clicked) and detail page,
 * so this page does not repeat that live status.
 *
 * The projection it subscribes to provides both avatar status and the directory freshness trigger. The first version was implemented as
 * “no session lease, no projection subscription,” leaving the page with no signal: the hook settled after its first response, and completed runs stayed
 * “running” forever. The lease + projection wiring exactly matches `SubagentDirectorySidePane`, which uses
 * `subagents.revision`; this key must be more selective (see `workflowRunDirectoryRefreshKey`) because dwf's
 * `revision` increments for every node event.
 */
function buildWorkflowRunDirectoryOpenRequest(
  tab: WorkflowRunDirectorySidePaneTab,
  row: WorkflowRunDirectoryRow,
): OpenScopedWorkflowRunSideTabRequest {
  return {
    workspacePath: tab.workspacePath,
    ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
    ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    parentSessionId: tab.parentSessionId,
    runId: row.runId,
    toolCallId: row.toolCallId,
    // Freeze the display name into the tab only as a title fallback when the projection is unavailable (see WorkflowRunSidePaneTab's comment).
    ...(row.label ? { workflowName: row.label } : {}),
  };
}

const DirectoryRow = memo(function DirectoryRow({
  onOpen,
  row,
  actors,
}: {
  onOpen: (row: WorkflowRunDirectoryRow) => void;
  row: WorkflowRunDirectoryRow;
  actors?: WorkflowRunState["actors"];
}) {
  const { intl } = useZCodeIntl();
  // Use the same fallback name as tool cards/task lists for unnamed runs; never expose the runId.
  const name = row.label ?? intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
  const statusLabel = intl.formatMessage({
    id: `chat.toolCall.workflow.run.status.${row.status}`,
  });
  const stopReason = readWorkflowRunStopReason(row);

  return (
    <button
      type="button"
      data-run-id={row.runId}
      data-run-status={row.status}
      aria-label={intl.formatMessage({ id: "chat.toolCall.workflow.openRunDetails" })}
      onClick={() => onOpen(row)}
      className="flex w-full min-w-0 items-start gap-3 rounded-lg px-3 py-2 text-left text-ui-base transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
    >
      <span className="flex h-[1lh] w-5 shrink-0 items-center justify-center">
        <span
          aria-hidden
          className={stationLampClass(
            row.status === "completed"
              ? "done"
              : row.status === "errored"
                ? "failed"
                : row.status === "stopped"
                  ? "pending"
                  : row.status,
          )}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-foreground">{name}</span>
          {row.status !== "completed" ? (
            <span className={cn("shrink-0 text-ui-sm", RUN_STATUS_TEXT[row.status])}>
              {statusLabel}
            </span>
          ) : null}
        </span>
        {(row.status === "running" || row.status === "completed") && actors?.length ? (
          <span className="mt-1 flex flex-wrap items-center gap-2">
            {actors.map((actor) => (
              <span key={`${actor.siteId}:${actor.ordinal}`} title={actor.name || actor.siteId}>
                <WorkflowAgentFace
                  avatarIndex={undefined}
                  name={actor.name || actor.siteId}
                  status={
                    actor.status === "completed"
                      ? "done"
                      : actor.status === "running"
                        ? "running"
                        : undefined
                  }
                  showCompletionMark={actor.status === "completed"}
                  className="size-4 min-h-4! min-w-4!"
                />
              </span>
            ))}
          </span>
        ) : null}
        {stopReason ? (
          <span className="mt-0.5 block truncate text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: workflowRunStopReasonMessageId(stopReason) })}
          </span>
        ) : (row.status === "errored" || row.status === "stopped") && row.failureCode ? (
          <span className="mt-0.5 block truncate text-ui-sm text-foreground-subtle">
            {row.failureCode}
          </span>
        ) : null}
      </span>
      {row.updatedAt === undefined ? null : (
        <span className="shrink-0 text-ui-sm text-foreground-subtle">
          {formatTaskRelativeTime(row.updatedAt, intl)}
        </span>
      )}
    </button>
  );
});

function DirectorySection({
  runs,
  countTestId,
  emptyLabel,
  emptyTestId,
  onOpen,
  rows,
  section,
  title,
}: {
  runs?: readonly WorkflowRunState[];
  countTestId: string;
  emptyLabel: string;
  emptyTestId: string;
  onOpen: (row: WorkflowRunDirectoryRow) => void;
  rows: readonly WorkflowRunDirectoryRow[];
  section: "running" | "ended";
  title: string;
}) {
  return (
    <section data-workflow-directory-section={section} className="[&+section]:mt-3">
      <h3 className="px-3 pb-1.5 text-ui-sm font-medium text-foreground-subtlest">
        {title} · <span data-testid={countTestId}>{rows.length}</span>
      </h3>
      {rows.length > 0 ? (
        rows.map((row) => (
          <DirectoryRow
            key={row.runId}
            row={row}
            actors={runs?.find((run) => run.runId === row.runId)?.actors}
            onOpen={onOpen}
          />
        ))
      ) : (
        <p data-testid={emptyTestId} className="px-3 py-3 text-ui-base text-foreground-subtlest">
          {emptyLabel}
        </p>
      )}
    </section>
  );
}

const WorkflowRunDirectoryContents = memo(function WorkflowRunDirectoryContents({
  onOpenWorkflowRun,
  tab,
}: {
  onOpenWorkflowRun: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  tab: WorkflowRunDirectorySidePaneTab;
}) {
  const { intl } = useZCodeIntl();
  const { layer } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);
  const projection = useConversationProjection(lease);
  useEffect(() => {
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);
  // The pane was opened from a live conversation, so `live: true` is accurate; `limit` shares
  // the same constant as the task-list count, since differing limits would create inconsistent results.
  //
  // `refreshKey` is the **only** basis for whether this page refreshes itself (observed bug: completed runs did not move to
  // “Finished” because no signal was connected here). The projection is only a trigger, not a source: rows still render
  // journal summaries, and live run steps and duration still appear only in the task list and detail page. The key shape (run count + settled count)
  // refetches when a run is added or completed, but not for node-level progress — see the model comment.
  const summaries = useWorkflowRunJournalSummaries({
    sessionId: tab.parentSessionId,
    live: true,
    limit: WORKFLOW_RUN_DIRECTORY_LIMIT,
    refreshKey: workflowRunDirectoryRefreshKey(projection.snapshot?.workflowRuns?.runs),
  });
  const directory = useMemo(() => buildWorkflowRunDirectory(summaries ?? null), [summaries]);
  const handleOpen = (row: WorkflowRunDirectoryRow) => {
    onOpenWorkflowRun(buildWorkflowRunDirectoryOpenRequest(tab, row));
  };
  // Distinguish three cases where there are no visible rows: unavailable list (summary missing) / no runs / one section is empty.
  const isUnavailable = summaries === null;
  const isEmpty = !isUnavailable && directory.running.length + directory.ended.length === 0;

  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {summaries === undefined ? (
          <p
            data-testid="workflow-run-directory-loading"
            role="status"
            className="px-3 py-3 text-ui-base text-foreground-subtlest"
          >
            {intl.formatMessage({ id: "common.loading" })}
          </p>
        ) : isUnavailable ? (
          // Avoid an error tone: the most common reason the list is unavailable is that this conversation's runtime does not support enumeration.
          <p
            data-testid="workflow-run-directory-unavailable"
            className="px-3 py-3 text-ui-base text-foreground-subtlest"
          >
            {intl.formatMessage({ id: "workflowDirectory.unavailable" })}
          </p>
        ) : isEmpty ? (
          <p
            data-testid="workflow-run-directory-empty"
            className="px-3 py-3 text-ui-base text-foreground-subtlest"
          >
            {intl.formatMessage({ id: "workflowDirectory.empty" })}
          </p>
        ) : (
          <>
            {directory.running.length > 0 ? (
              <DirectorySection
                runs={projection.snapshot?.workflowRuns?.runs}
                section="running"
                title={intl.formatMessage({ id: "workflowDirectory.running" })}
                rows={directory.running}
                countTestId="workflow-run-directory-running-count"
                emptyTestId="workflow-run-directory-running-empty"
                emptyLabel={intl.formatMessage({ id: "workflowDirectory.runningEmpty" })}
                onOpen={handleOpen}
              />
            ) : null}
            <DirectorySection
              runs={projection.snapshot?.workflowRuns?.runs}
              section="ended"
              title={intl.formatMessage({ id: "workflowDirectory.ended" })}
              rows={directory.ended}
              countTestId="workflow-run-directory-ended-count"
              emptyTestId="workflow-run-directory-ended-empty"
              emptyLabel={intl.formatMessage({ id: "workflowDirectory.endedEmpty" })}
              onOpen={handleOpen}
            />
            {/* State truncation explicitly: when a page is exactly full, claiming "that's all" would be false, and the query has no cursor for another page. */}
            {directory.truncated ? (
              <p
                data-testid="workflow-run-directory-truncated"
                className="px-3 pt-4 text-ui-sm text-foreground-subtlest"
              >
                {intl.formatMessage(
                  { id: "workflowDirectory.truncated" },
                  { count: String(WORKFLOW_RUN_DIRECTORY_LIMIT) },
                )}
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
});

export const WorkflowRunDirectorySidePane = memo(function WorkflowRunDirectorySidePane({
  onOpenWorkflowRun,
  tab,
}: {
  onOpenWorkflowRun: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  tab: WorkflowRunDirectorySidePaneTab;
}) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );
  return (
    <V4PaneConversationProvider scope={scope}>
      <WorkflowRunDirectoryContents tab={tab} onOpenWorkflowRun={onOpenWorkflowRun} />
    </V4PaneConversationProvider>
  );
});
