import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRightIcon, Loader2Icon, Undo2Icon } from "lucide-react";
import type {
  CommandAck,
  ConversationRowTarget,
  TurnHeaderRow,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
} from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  persistChangeSummaryTreeViewPreference,
  readChangeSummaryTreeViewPreference,
} from "@/lib/changeSummaryTreeViewPreference.js";
import { cn } from "@/components/lib/utils.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { collectGenUiSourcePaths, matchesGenUiSourcePath } from "@/gen-ui/contract.js";
import { ConversationFileSummaryList } from "@/v4/ConversationFileSummaryList.js";
import { ConversationFileRewindDialog } from "@/v4/ConversationFileRewindDialog.js";
import type {
  ConversationFileChangesRequestOptions,
  ConversationRowRenderContext,
} from "@/v4/conversationRowContext.js";

interface ConversationFileSummaryPanelProps {
  header: TurnHeaderRow;
  context: ConversationRowRenderContext;
  assistantText?: string;
}

export function ConversationFileSummaryPanel({
  header,
  context,
  assistantText = "",
}: ConversationFileSummaryPanelProps) {
  const { intl } = useZCodeIntl();
  const genUiSources = useMemo(() => collectGenUiSourcePaths(assistantText), [assistantText]);
  const filtersSources = genUiSources.length > 0;
  const [open, setOpen] = useState(false);
  const [isTreeView, setIsTreeView] = useState(readChangeSummaryTreeViewPreference);
  const [loadedDetails, setLoadedDetails] = useState<{
    key: string;
    result: V4ConversationFileChangesResult | null;
  } | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [preview, setPreview] = useState<V4ConversationFileRewindPreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cachePolicy: ConversationFileChangesRequestOptions["cachePolicy"] =
    header.state === "running" ? "in-flight" : "terminal";
  const fileChangesState = header.fileChanges?.state;
  // The header contains only aggregate values. Read details from the current projection and filter them; do not guess and subtract source-file rows from ordinary files.
  const requestKey = JSON.stringify([
    context.workspaceIdentity?.trim() || context.workspacePath,
    context.workspaceRemoteSessionId,
    context.sessionId,
    header.rowId,
    header.entityId,
    cachePolicy,
    header.fileChanges,
  ]);
  const settled = loadedDetails?.key === requestKey;
  const details = settled ? loadedDetails.result : null;
  const items = useMemo(
    () => details?.items.filter((item) => !matchesGenUiSourcePath(item.path, genUiSources)) ?? [],
    [details, genUiSources],
  );
  const summary =
    details && items.length !== details.items.length && header.fileChanges
      ? {
          ...header.fileChanges,
          files: items.length,
          additions: items.reduce((sum, item) => sum + (item.additions ?? 0), 0),
          deletions: items.reduce((sum, item) => sum + (item.deletions ?? 0), 0),
        }
      : header.fileChanges;

  const filesChangedLabel = intl.formatPlural(
    { id: "chat.changeSummary.filesChanged" },
    summary?.files ?? 0,
  );
  const isReverted = summary?.state === "reverted";
  const canUndo =
    Boolean(context.applyFileRewind && context.previewFileRewind) &&
    header.actions?.canRewindFiles === true &&
    !isReverted;
  const target = useMemo<ConversationRowTarget | null>(
    () => (header.entityId ? { rowId: header.rowId, entityId: header.entityId } : null),
    [header.entityId, header.rowId],
  );
  const needsDetails = open || filtersSources;

  useEffect(() => {
    if (!needsDetails || !context.fetchFileChanges || !target) return;

    let disposed = false;
    // fileChanges while running is a local result for a projection revision. Once the turn reaches a terminal state,
    // discard local details and read again using the persistently cacheable terminal-state strategy.
    // requestKey already isolates stale results synchronously. Preserve loaded content when rereading the same expanded summary to avoid unmounting the button and losing focus.
    setLoadingDetails(true);
    void context
      .fetchFileChanges(target, {
        cachePolicy,
        fileChangesState,
      })
      .then(
        (result) => {
          if (disposed) return;
          setLoadedDetails({ key: requestKey, result });
          setLoadingDetails(false);
        },
        (loadError: unknown) => {
          if (disposed) return;
          logger.warn("[ConversationFileSummaryPanel] 读取文件变更详情失败", {
            error: loadError instanceof Error ? loadError.message : String(loadError),
            rowId: target.rowId,
          });
          setLoadedDetails({ key: requestKey, result: null });
          setLoadingDetails(false);
        },
      );

    return () => {
      disposed = true;
    };
  }, [
    cachePolicy,
    context.fetchFileChanges,
    fileChangesState,
    needsDetails,
    open,
    requestKey,
    target,
  ]);

  const handlePreviewRewind = useCallback(async () => {
    if (!context.previewFileRewind || !target) return;
    setDialogOpen(true);
    setPreviewLoading(true);
    setError(null);
    try {
      setPreview(await context.previewFileRewind(target));
    } catch {
      setError(intl.formatMessage({ id: "chat.changeSummary.rewindDialog.error" }));
    } finally {
      setPreviewLoading(false);
    }
  }, [context, intl, target]);

  const handleApply = useCallback(async () => {
    if (!context.applyFileRewind || !preview?.canApply || !target) return;
    setApplying(true);
    setError(null);
    try {
      const ack: CommandAck = await context.applyFileRewind(target);
      if (ack.status === "accepted" || ack.status === "duplicate") {
        setDialogOpen(false);
      } else {
        setError(
          ack.message ?? intl.formatMessage({ id: "chat.changeSummary.rewindDialog.error" }),
        );
      }
    } catch {
      setError(intl.formatMessage({ id: "chat.changeSummary.rewindDialog.error" }));
    } finally {
      setApplying(false);
    }
  }, [context, intl, preview?.canApply, target]);

  useEffect(() => {
    if (
      !details ||
      !header.fileChanges ||
      header.fileChanges.files <= 0 ||
      details.items.length > 0
    ) {
      return;
    }
    logger.warn("[ConversationFileSummaryPanel] 文件摘要详情为空", {
      expectedFiles: header.fileChanges.files,
      rowId: header.rowId,
      turnId: header.turnId,
    });
  }, [details, header.rowId, header.turnId, header.fileChanges]);

  // Do not flash aggregate source-file statistics before details arrive; restore the original summary after a read failure so it can still be expanded and retried.
  if (filtersSources && context.fetchFileChanges && target && !settled) return null;
  if (!summary || summary.files <= 0) return null;

  return (
    <>
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className="overflow-hidden rounded-xl border border-border bg-card shadow-none"
      >
        <div className="flex h-10 items-center justify-between gap-3 px-2 transition-colors hover:bg-hover">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex h-full min-w-0 flex-1 items-center gap-2 px-1 text-left text-ui-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
              aria-label={intl.formatMessage({
                id: open ? "chat.changeSummary.collapse" : "chat.changeSummary.expand",
              })}
            >
              <ChevronRightIcon
                aria-hidden
                className={cn(
                  "size-3.5 shrink-0 text-foreground-subtlest transition-transform",
                  open ? "rotate-90" : "rotate-0",
                )}
              />
              <span className="min-w-0 truncate font-medium">{filesChangedLabel}</span>
              <span className="shrink-0 tabular-nums">
                <span className="text-diff-added">+{summary.additions}</span>{" "}
                <span className="text-diff-removed">-{summary.deletions}</span>
              </span>
              {isReverted ? (
                <span className="shrink-0 rounded-sm bg-input px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
                  {intl.formatMessage({ id: "chat.changeSummary.reverted" })}
                </span>
              ) : null}
            </button>
          </CollapsibleTrigger>
          {open && summary.files > 1 ? (
            <label className="flex min-w-0 cursor-pointer items-center gap-2 px-1 text-ui-base text-foreground-subtle">
              <Checkbox
                checked={isTreeView}
                onCheckedChange={(checked) => {
                  const next = checked === true;
                  setIsTreeView(next);
                  persistChangeSummaryTreeViewPreference(next);
                }}
              />
              <span className="truncate">
                {intl.formatMessage({ id: "chat.changeSummary.treeView" })}
              </span>
            </label>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!canUndo || previewLoading || applying}
            onClick={handlePreviewRewind}
            title={intl.formatMessage({ id: "chat.changeSummary.rewind" })}
          >
            {previewLoading || applying ? <Loader2Icon className="animate-spin" /> : <Undo2Icon />}
            <span>{intl.formatMessage({ id: "chat.changeSummary.rewind" })}</span>
          </Button>
        </div>
        <CollapsibleContent>
          <div className="grid w-full border-t border-border">
            {loadingDetails ? (
              <div className="flex h-8 items-center gap-2 px-2 text-ui-base text-foreground-subtle">
                <Loader2Icon className="size-3.5 animate-spin" />
                {intl.formatMessage({
                  id: "chat.changeSummary.rewindDialog.loading",
                })}
              </div>
            ) : details && items.length === 0 ? (
              <div className="px-2 py-1.5 text-ui-base text-foreground-subtle">
                {intl.formatMessage({
                  id: "chat.changeSummary.diffUnavailable",
                })}
              </div>
            ) : (
              <ConversationFileSummaryList
                key={isTreeView ? "tree" : "flat"}
                items={items}
                context={context}
                isTreeView={isTreeView}
              />
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>

      <ConversationFileRewindDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        preview={preview}
        previewLoading={previewLoading}
        applying={applying}
        error={error}
        onApply={handleApply}
      />
    </>
  );
}
