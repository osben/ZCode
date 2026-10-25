import { useEffect, useState } from "react";
import { FileDiffIcon } from "lucide-react";
import type { V4ConversationFileChangesResult } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { toWorkspaceRelativePath } from "@/lib/taskChangeSummary.js";
import { logger } from "@/logger.js";
import { formatReadonlyDiffPatch } from "@/review-last-turn/index.js";
import type { LastTurnFetchFileChanges, LastTurnSectionModel } from "./contract.js";

type FileChangeItem = V4ConversationFileChangesResult["items"][number];

export interface LastTurnSectionScope {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}

/** Header status content: the turn aggregate, available without a detail fetch. */
export function LastTurnSectionTrailing({ model }: { model: LastTurnSectionModel }) {
  const { intl } = useZCodeIntl();
  return (
    <span data-status-panel-last-turn-summary="true" className="flex min-w-0 items-center gap-1.5">
      <span className="truncate">
        {intl.formatPlural({ id: "chat.statusPanel.lastTurnFiles" }, model.files)}
      </span>
      <span className="shrink-0 font-mono tabular-nums">
        <span className="text-[var(--color-diff-added)]">+{model.additions}</span>{" "}
        <span className="text-[var(--color-diff-removed)]">-{model.deletions}</span>
      </span>
      {model.reverted ? (
        <span className="shrink-0">
          {`· ${intl.formatMessage({ id: "chat.statusPanel.lastTurnReverted" })}`}
        </span>
      ) : null}
    </span>
  );
}

function splitPath(relativePath: string) {
  const index = relativePath.lastIndexOf("/");
  return index < 0
    ? { name: relativePath, dir: "" }
    : { name: relativePath.slice(index + 1), dir: relativePath.slice(0, index) };
}

/**
 * Mounted only while the section is expanded (CollapsibleContent unmounts it), so details are read only then.
 * The result is keyed by scope and turn facts; a response for an older key is dropped.
 */
export function LastTurnSectionBody({
  model,
  scope,
  fetchFileChanges,
  onOpenCodeViewer,
  onOpenReview,
}: {
  model: LastTurnSectionModel;
  scope: LastTurnSectionScope;
  fetchFileChanges?: LastTurnFetchFileChanges;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenReview?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const requestKey = JSON.stringify([
    scope.workspaceIdentity?.trim() || scope.workspacePath,
    scope.workspaceRemoteSessionId,
    scope.sessionId,
    model.target.rowId,
    model.target.entityId,
    model.requestOptions.cachePolicy,
    model.files,
    model.additions,
    model.deletions,
    model.requestOptions.fileChangesState,
  ]);
  const [loaded, setLoaded] = useState<{
    key: string;
    items: readonly FileChangeItem[] | null;
  } | null>(null);
  const { rowId, entityId } = model.target;
  const { cachePolicy, fileChangesState } = model.requestOptions;

  useEffect(() => {
    if (!fetchFileChanges) return;
    let disposed = false;
    void fetchFileChanges(
      { rowId, entityId },
      { cachePolicy, ...(fileChangesState ? { fileChangesState } : {}) },
    ).then(
      (result) => {
        if (!disposed) setLoaded({ key: requestKey, items: result.items });
      },
      (error: unknown) => {
        if (disposed) return;
        logger.warn("[StatusPanelLastTurn] failed to read turn file changes", {
          error: error instanceof Error ? error.message : String(error),
          rowId,
        });
        setLoaded({ key: requestKey, items: null });
      },
    );
    return () => {
      disposed = true;
    };
  }, [cachePolicy, entityId, fetchFileChanges, fileChangesState, requestKey, rowId]);

  const items = loaded?.key === requestKey ? loaded.items : null;
  const openFile = (item: FileChangeItem) => {
    const patch = formatReadonlyDiffPatch(item.path, item.patches);
    if (!patch || !onOpenCodeViewer) return;
    onOpenCodeViewer({
      type: "patch",
      title: toWorkspaceRelativePath(scope.workspacePath, item.path),
      path: item.path,
      patch,
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      ...(scope.workspaceRemoteSessionId
        ? { workspaceRemoteSessionId: scope.workspaceRemoteSessionId }
        : {}),
    });
  };

  return (
    <div data-status-panel-last-turn="body" className="flex flex-col">
      {items?.map((item) => {
        const relativePath = toWorkspaceRelativePath(scope.workspacePath, item.path);
        const { name, dir } = splitPath(relativePath);
        const canOpen = Boolean(onOpenCodeViewer) && item.patches.length > 0;
        return (
          <button
            key={item.path}
            type="button"
            disabled={!canOpen}
            title={relativePath}
            data-status-panel-last-turn-file={relativePath}
            onClick={() => openFile(item)}
            className={cn(
              "flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-ui-base text-[var(--color-foreground)] transition-colors",
              canOpen
                ? "hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-input-border-focused)]"
                : "cursor-default",
            )}
          >
            <span className="min-w-0 shrink truncate">{name}</span>
            <span className="min-w-0 flex-1 truncate text-ui-sm text-[var(--color-foreground-subtlest)]">
              {dir}
            </span>
            {item.writeCount > 1 ? (
              <span
                className="shrink-0 text-ui-sm text-[var(--color-foreground-subtle)]"
                title={intl.formatMessage(
                  { id: "chat.statusPanel.lastTurnWriteCount" },
                  { count: item.writeCount },
                )}
              >
                ×{item.writeCount}
              </span>
            ) : null}
            <span className="shrink-0 font-mono text-ui-sm tabular-nums">
              <span className="text-[var(--color-diff-added)]">+{item.additions}</span>{" "}
              <span className="text-[var(--color-diff-removed)]">-{item.deletions}</span>
            </span>
          </button>
        );
      })}
      {onOpenReview ? (
        <button
          type="button"
          data-status-panel-last-turn-review="true"
          onClick={onOpenReview}
          className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-ui-base text-[var(--color-foreground-subtle)] transition-colors hover:bg-[var(--color-hover)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-input-border-focused)]"
        >
          <FileDiffIcon className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">
            {intl.formatMessage({ id: "chat.statusPanel.lastTurnOpenReview" })}
          </span>
        </button>
      ) : null}
    </div>
  );
}
