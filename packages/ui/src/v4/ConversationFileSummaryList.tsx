import { useMemo, useState } from "react";
import { ChevronRightIcon, FolderIcon } from "lucide-react";
import type { V4ConversationFileChangesResult } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildChangeSummaryTree } from "@/lib/changeSummaryTree.js";
import { FileDisplayInline } from "@/lib/fileDisplay.js";
import { toWorkspaceRelativePath } from "@/lib/taskChangeSummary.js";
import { buildChangeSummaryFilePreviewSource } from "@/messageChangeSummaryPreview.js";
import { OpenSplitButton } from "@/OpenSplitButton.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";

type FileChangeItem = V4ConversationFileChangesResult["items"][number];

// Cap indentation so deep paths do not squeeze rows on narrow (mobile remote) widths.
const MAX_INDENT_DEPTH = 6;

function indentPx(depth: number): number {
  return 8 + Math.min(depth, MAX_INDENT_DEPTH) * 16;
}

function formatPatch(path: string, patches: FileChangeItem["patches"]): string {
  if (patches.length === 0) return "";
  const lines = [`--- a/${path}`, `+++ b/${path}`];
  for (const patch of patches) {
    lines.push(
      `@@ -${patch.oldStart},${patch.oldLines} +${patch.newStart},${patch.newLines} @@`,
      ...patch.lines,
    );
  }
  return lines.join("\n");
}

function openDiff(
  item: FileChangeItem,
  context: Pick<
    ConversationRowRenderContext,
    "workspacePath" | "workspaceIdentity" | "workspaceRemoteSessionId" | "onOpenCodeViewer"
  >,
) {
  const patch = formatPatch(item.path, item.patches);
  const { workspacePath, workspaceIdentity, workspaceRemoteSessionId, onOpenCodeViewer } = context;
  if (!patch || !onOpenCodeViewer) return;
  const relativePath = toWorkspaceRelativePath(workspacePath, item.path);
  onOpenCodeViewer({
    type: "patch",
    title: relativePath,
    path: item.path,
    patch,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
  });
}

interface ConversationFileSummaryListProps {
  isTreeView: boolean;
  items: readonly FileChangeItem[];
  context: ConversationRowRenderContext;
}

export function ConversationFileSummaryList({
  items,
  context,
  isTreeView,
}: ConversationFileSummaryListProps) {
  const { intl } = useZCodeIntl();
  // The parent keys this list by view mode, so collapse state resets whenever the mode toggles.
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(() => new Set());
  const treeRows = useMemo(
    () =>
      buildChangeSummaryTree(
        items.map((item) => ({
          item,
          path: item.path,
          relativePath: toWorkspaceRelativePath(context.workspacePath, item.path),
          added: item.additions ?? 0,
          removed: item.deletions ?? 0,
        })),
        collapsedFolders,
      ),
    [items, context.workspacePath, collapsedFolders],
  );

  const renderFileRow = (item: FileChangeItem, depth: number, inTree: boolean) => {
    const relativePath = toWorkspaceRelativePath(context.workspacePath, item.path);
    const canReview = item.patches.length > 0 && Boolean(context.onOpenCodeViewer);
    const filePreviewSource = buildChangeSummaryFilePreviewSource({
      path: item.path,
      relativePath,
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
      workspaceRemoteSessionId: context.workspaceRemoteSessionId,
    });
    return (
      <div key={item.path} className="w-full bg-background/50 overflow-hidden">
        <div
          style={inTree ? { paddingLeft: `${indentPx(depth)}px` } : undefined}
          aria-disabled={!canReview}
          className={cn(
            "flex w-full items-center gap-1 px-2 py-2 text-left transition-colors",
            canReview ? "cursor-pointer hover:bg-hover/30" : "cursor-default",
          )}
          onClick={() => openDiff(item, context)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            openDiff(item, context);
          }}
          role="button"
          tabIndex={canReview ? 0 : -1}
          title={item.path}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="min-w-0 flex items-center">
              <FileDisplayInline
                path={item.path}
                options={{
                  basePath: context.workspacePath,
                  showFilePath: !inTree,
                  // Row label reads as one continuous path: [icon] dir/name with no flex gap
                  // between directory and basename. The directory goes first, carries the
                  // whole shrink weight and ellipsizes from its start (leading "…"), keeping
                  // the segments closest to the file; the basename never competes for width
                  // (truncate is only degradation for oversized names).
                  pathBeforeName: true,
                  className: inTree
                    ? "inline-flex min-w-0 max-w-full items-center gap-1.5"
                    : "inline-flex min-w-0 max-w-full items-center [&>img+span]:ml-1.5",
                  fileNameClassName: "truncate text-ui-base font-medium text-foreground",
                  filePathClassName:
                    "ml-1.5 min-w-[2ch] shrink-[10000] truncate text-ui-base text-foreground-subtlest [direction:rtl] [text-align:left]",
                }}
              />
            </div>
            {/* Fix reason: writeCount is an operation trace used by undo preflight, while the summary
                row already shows the final result with +/-. Showing it here would make
                internal operation counts look like change metrics, so keep it only in
                the undo dialog. */}
            <span className="flex shrink-0 items-center gap-2 tabular-nums text-ui-base">
              {item.additions > 0 ? (
                <span className="text-diff-added">+{item.additions}</span>
              ) : null}
              {item.deletions > 0 ? (
                <span className="text-diff-removed">-{item.deletions}</span>
              ) : null}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="default"
              aria-label={intl.formatMessage({
                id: "chat.changeSummary.review",
              })}
              title={intl.formatMessage({
                id: "chat.changeSummary.review",
              })}
              disabled={!canReview}
              className="h-7 gap-1.5 rounded-lg bg-input px-2 text-ui-base"
              onClick={(event) => {
                event.stopPropagation();
                openDiff(item, context);
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <span>
                {intl.formatMessage({
                  id: "chat.changeSummary.review",
                })}
              </span>
            </Button>
            <OpenSplitButton
              target={{
                type: "file",
                path: item.path,
                title: relativePath,
                label: relativePath,
                previewSource: filePreviewSource,
              }}
              onOpenCodeViewer={context.onOpenCodeViewer}
              hideOpenWithMenu={context.compactForRemoteControl === true}
              stopPropagation
            />
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      {isTreeView && items.length > 1
        ? treeRows.map((row) => {
            if (row.kind === "file") return renderFileRow(row.file.item, row.depth, true);
            const isFolderCollapsed = collapsedFolders.has(row.id);
            return (
              <button
                key={`dir:${row.id}`}
                type="button"
                aria-expanded={!isFolderCollapsed}
                title={row.id}
                style={{ paddingLeft: `${indentPx(row.depth)}px` }}
                className="flex w-full items-center gap-1.5 py-1.5 pr-2 text-left transition-colors hover:bg-hover/30"
                onClick={() =>
                  setCollapsedFolders((previous) => {
                    const next = new Set(previous);
                    if (!next.delete(row.id)) next.add(row.id);
                    return next;
                  })
                }
              >
                <ChevronRightIcon
                  aria-hidden
                  className={cn(
                    "size-3.5 shrink-0 text-foreground-subtlest transition-transform",
                    !isFolderCollapsed && "rotate-90",
                  )}
                />
                <FolderIcon aria-hidden className="size-3.5 shrink-0 text-foreground-subtlest" />
                <span className="min-w-0 truncate text-ui-base text-foreground">{row.name}</span>
                <span className="flex shrink-0 items-center gap-2 tabular-nums text-ui-base">
                  {row.added > 0 ? <span className="text-diff-added">+{row.added}</span> : null}
                  {row.removed > 0 ? (
                    <span className="text-diff-removed">-{row.removed}</span>
                  ) : null}
                </span>
              </button>
            );
          })
        : items.map((item) => renderFileRow(item, 0, false))}
    </>
  );
}
