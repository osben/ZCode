import type { EditorInfo } from "@zcode/shared";
import { ChevronDownIcon, CopyIcon, ExternalLinkIcon, PanelRightIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu.js";
import {
  DefaultFileApplicationLabel,
  FileApplicationChoices,
  FileSaveAsMenuItem,
  useFileApplications,
} from "@/file-menu/index.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { persistLastSelectedEditorId } from "@/lib/editorPreference.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { getWorkspaceFileRelativePath } from "@/workspace-file-tree/model.js";
import { resolveWorkspaceEditorSelection } from "@/lib/workspaceEditorSelection.js";
import { logger } from "@/logger.js";

// Export the type for the shared timeline to import as a type (erased at build time, so the open-with subtree is not included in the public-page bundle).
export type OpenSplitButtonTarget =
  | {
      type: "website";
      url: string;
      localPath?: string;
      workspacePath?: string;
    }
  | {
      type: "file";
      path: string;
      title: string;
      label: string;
      previewSource?: CodeViewerSource;
    };

interface OpenSplitButtonProps {
  target: OpenSplitButtonTarget;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  hideOpenWithMenu?: boolean;
  openDefaultOnPrimary?: boolean;
  /** Preview-specific display options appended after the unified file actions; do not duplicate file operations. */
  viewMenuItems?: ReactNode;
  stopPropagation?: boolean;
  /** The whole card reuses the button's actions and state; context menu and dropdown do not keep a second set. */
  renderCard?: (
    button: ReactNode,
    /** Whole-card click reuses the primary button's preview action and availability. */
    actions: { handlePreview: () => void; canPreview: boolean },
  ) => ReactElement;
}

export function OpenSplitButton({
  target,
  onOpenBrowserUrl,
  onOpenFileLink,
  onOpenCodeViewer,
  hideOpenWithMenu = false,
  openDefaultOnPrimary = false,
  viewMenuItems,
  stopPropagation = false,
  renderCard,
}: OpenSplitButtonProps) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();

  const previewSource = target.type === "file" ? target.previewSource : undefined;
  const matchedOpenContext = useWorkspaceOpenInEditorTarget({
    workspacePath: previewSource?.workspacePath,
    workspaceIdentity: previewSource?.workspaceIdentity,
    workspaceRemoteSessionId: previewSource?.workspaceRemoteSessionId,
  });
  const openInEditorRemoteTarget = matchedOpenContext.remoteTarget;
  const isRemoteSource = Boolean(
    previewSource?.workspaceIdentity ||
    previewSource?.workspaceRemoteSessionId ||
    matchedOpenContext.isRemoteWorkspace,
  );
  const fileActions = useFileContextActions({
    canOpenLocalFileManager: Boolean(platform.canOpenLocalFiles),
    isRemoteWorkspace: isRemoteSource,
    remoteTarget: openInEditorRemoteTarget,
    workspaceIdentity: previewSource?.workspaceIdentity,
  });
  const filePath = target.type === "file" ? target.path : target.localPath;
  const workspacePath =
    target.type === "file" ? previewSource?.workspacePath : target.workspacePath;
  const canOpenNative = Boolean(platform.canOpenLocalFiles && !isRemoteSource);
  const fileApplications = useFileApplications(
    target.type === "file"
      ? { path: target.path, pathKind: "file", workspaceIdentity: previewSource?.workspaceIdentity }
      : null,
    isRemoteSource,
  );
  const defaultApplication = fileApplications.defaultApplication;
  const defaultApplicationTitle = intl.formatMessage(
    {
      id: defaultApplication ? "fileActions.openInApplication" : "chat.previewCards.openDefaultApp",
    },
    defaultApplication ? { application: defaultApplication.name } : undefined,
  );
  useEffect(() => {
    if (openDefaultOnPrimary && canOpenNative) void fileApplications.load();
  }, [openDefaultOnPrimary, canOpenNative, fileApplications.load]);
  const editorRequest = useRef(0);
  const primaryEditorLoadStarted = useRef(false);
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [editorsLoaded, setEditorsLoaded] = useState(false);
  const [loadingEditors, setLoadingEditors] = useState(false);
  const sortedEditors: Array<EditorInfo & { isDefault?: boolean }> = useMemo(
    () =>
      !isRemoteSource
        ? fileApplications.apps.map((app) => ({ ...app, iconDataUrl: app.iconDataUrl ?? "" }))
        : isRemoteSource && !openInEditorRemoteTarget
          ? []
          : resolveWorkspaceEditorSelection({
              installedEditors: editors,
              selectedEditorId: null,
              remoteTarget: openInEditorRemoteTarget,
            }).availableEditors,
    [editors, isRemoteSource, openInEditorRemoteTarget, fileApplications.apps],
  );
  const canPreview = openDefaultOnPrimary
    ? Boolean(canOpenNative || sortedEditors.length)
    : target.type === "website"
      ? Boolean(onOpenBrowserUrl)
      : Boolean(onOpenFileLink || onOpenCodeViewer);
  useEffect(() => {
    primaryEditorLoadStarted.current = false;
    setEditors([]);
    setEditorsLoaded(false);
    setLoadingEditors(false);
    // When a virtualized card row is reused, async app results for the old target must not overwrite the new one.
    editorRequest.current += 1;
    return () => {
      editorRequest.current += 1;
    };
  }, [
    filePath,
    workspacePath,
    previewSource?.workspaceIdentity,
    previewSource?.workspaceRemoteSessionId,
  ]);

  const stopEventPropagation = (event: { stopPropagation: () => void }) => {
    if (stopPropagation) {
      event.stopPropagation();
    }
  };

  const loadEditors = useCallback(async () => {
    if (target.type !== "file") return;
    if (!isRemoteSource) {
      await fileApplications.load();
      return;
    }
    if (editorsLoaded || loadingEditors) {
      return;
    }

    const request = ++editorRequest.current;
    setLoadingEditors(true);
    try {
      const result = await platform.getInstalledEditors(target.path);
      if (request !== editorRequest.current) return;
      setEditors(result);
      setEditorsLoaded(true);
    } catch (error) {
      if (request !== editorRequest.current) return;
      logger.warn("[OpenSplitButton] 获取第三方打开方式失败", {
        path: target.path,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (request === editorRequest.current) setLoadingEditors(false);
    }
  }, [editorsLoaded, loadingEditors, platform, target, isRemoteSource, fileApplications.load]);

  useEffect(() => {
    // The remote primary button also needs available editors fetched early; do not wait for the user to open the dropdown to enable it.
    // Auto-request once per source; after a failure the user can still reopen the menu to retry, avoiding render-loop retries.
    if (
      openDefaultOnPrimary &&
      isRemoteSource &&
      openInEditorRemoteTarget &&
      !primaryEditorLoadStarted.current &&
      !editorsLoaded &&
      !loadingEditors
    ) {
      primaryEditorLoadStarted.current = true;
      void loadEditors();
    }
  }, [
    openDefaultOnPrimary,
    isRemoteSource,
    openInEditorRemoteTarget,
    loadEditors,
    editorsLoaded,
    loadingEditors,
  ]);

  const handlePreview = () => {
    if (openDefaultOnPrimary) {
      if (canOpenNative) handleOpenDefault();
      else if (sortedEditors[0]) handleOpenInEditor(sortedEditors[0]);
      return;
    }
    if (target.type === "website") {
      onOpenBrowserUrl?.(target.url);
      return;
    }

    if (onOpenCodeViewer) {
      onOpenCodeViewer(
        target.previewSource ?? {
          type: "file",
          title: target.title,
          path: target.path,
        },
      );
      return;
    }

    onOpenFileLink?.({
      path: target.path,
      label: target.label,
      pathKind: "file",
      workspacePath: target.previewSource?.workspacePath,
      workspaceIdentity: target.previewSource?.workspaceIdentity,
      workspaceRemoteSessionId: target.previewSource?.workspaceRemoteSessionId,
    });
  };

  const handleOpenInEditor = (editor: EditorInfo) => {
    if (target.type !== "file") {
      return;
    }

    if (!isRemoteSource) {
      void fileApplications.open({ ...editor, isDefault: false });
      return;
    }
    persistLastSelectedEditorId(editor.id);
    // Both a failed result and an IPC rejection must produce visible feedback, not just a log line that ends silently.
    void platform
      .openInEditor(editor.id, target.path, {
        pathKind: "file",
        remoteTarget: openInEditorRemoteTarget,
        workspaceIdentity: target.previewSource?.workspaceIdentity,
      })
      .then((result) => {
        if (!result.success) throw new Error(result.error ?? "unknown-error");
      })
      .catch((error: unknown) => {
        logger.warn("[OpenSplitButton] 第三方 App 打开文件失败", {
          editorId: editor.id,
          path: target.path,
          error: error instanceof Error ? error.message : String(error),
        });
        toast(intl.formatMessage({ id: "chat.previewCards.openFileFailed" }));
      });
  };

  const handleOpenExternal = () => {
    if (target.type !== "website" || !target.localPath || !platform.openExternalFile) {
      platform.openExternal(target.type === "website" ? target.url : target.path);
      return;
    }

    const localPath = target.localPath;
    const reportFailure = (error: unknown) => {
      logger.warn("[OpenSplitButton] 浏览器打开本地文件失败", {
        path: localPath,
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "chat.previewCards.openExternalFailed" }));
    };
    void platform
      .openExternalFile(localPath)
      .then((result) => {
        if (!result.success) reportFailure(result.error ?? "unknown-error");
      })
      .catch(reportFailure);
  };

  const handleOpenDefault = () => {
    void fileApplications.openDefault();
  };

  // Card context menu and the Open dropdown share app queries and save actions.
  const renderContextActions = () => {
    const Item = ContextMenuItem;
    const Separator = ContextMenuSeparator;
    return (
      <>
        <Item disabled={!canPreview} onSelect={handlePreview}>
          <PanelRightIcon className="size-4" />
          {intl.formatMessage({
            id: "chat.previewCards.previewInSidePane",
          })}
        </Item>
        {target.type === "website" ? (
          <Item onSelect={handleOpenExternal}>
            <ExternalLinkIcon className="size-4" />
            {intl.formatMessage({ id: "common.open" })}
          </Item>
        ) : (
          <>
            {platform.canOpenLocalFiles && (!isRemoteSource || openInEditorRemoteTarget) && (
              <FileApplicationChoices
                variant="context"
                applications={sortedEditors}
                loading={loadingEditors || fileApplications.loading}
                onOpenDefault={
                  canOpenNative && platform.openExternalFile ? handleOpenDefault : undefined
                }
                onSelect={handleOpenInEditor}
              />
            )}
          </>
        )}
        {target.type === "file" && (
          <FileSaveAsMenuItem
            variant="context"
            path={target.path}
            workspacePath={workspacePath}
            workspaceIdentity={previewSource?.workspaceIdentity}
            workspaceRemoteSessionId={previewSource?.workspaceRemoteSessionId}
          />
        )}
        <Separator />
        {target.type === "website" && (
          <Item onSelect={() => void fileActions.copyAbsolutePath({ path: target.url })}>
            <CopyIcon className="size-4" />
            {intl.formatMessage({ id: "chat.previewCards.copyLink" })}
          </Item>
        )}
        {filePath && (
          <>
            {workspacePath && (
              <Item
                onSelect={() =>
                  void fileActions.copyRelativePath({
                    path: filePath,
                    relativePath: getWorkspaceFileRelativePath(workspacePath, filePath),
                  })
                }
              >
                <CopyIcon className="size-4" />
                {intl.formatMessage({ id: "fileActions.copyRelativePath" })}
              </Item>
            )}
            <Item onSelect={() => void fileActions.copyAbsolutePath({ path: filePath })}>
              <CopyIcon className="size-4" />
              {intl.formatMessage({ id: "fileActions.copyAbsolutePath" })}
            </Item>
          </>
        )}
      </>
    );
  };

  const button = (
    <DropdownMenu onOpenChange={(open) => open && void loadEditors()}>
      <div
        className="flex h-7 shrink-0 items-center overflow-hidden rounded-lg border border-border bg-input transition-all hover:border-border-hover"
        onClick={stopEventPropagation}
        onPointerDown={stopEventPropagation}
      >
        <Button
          type="button"
          variant="ghost"
          size="default"
          className={`h-7 rounded-none border-0 gap-1 ${hideOpenWithMenu ? "px-2" : "pr-1.5"}`}
          disabled={!canPreview}
          title={openDefaultOnPrimary ? defaultApplicationTitle : undefined}
          aria-label={openDefaultOnPrimary ? defaultApplicationTitle : undefined}
          onClick={(event) => {
            stopEventPropagation(event);
            handlePreview();
          }}
        >
          {openDefaultOnPrimary ? (
            <DefaultFileApplicationLabel application={defaultApplication}>
              {intl.formatMessage({ id: "common.open" })}
            </DefaultFileApplicationLabel>
          ) : (
            intl.formatMessage({ id: "common.open" })
          )}
        </Button>
        {!hideOpenWithMenu && (
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              className="!w-5 rounded-none border-0 text-foreground-subtlest"
              aria-label={intl.formatMessage({ id: "appHeader.selectOpenApp" })}
              title={intl.formatMessage({ id: "appHeader.selectOpenApp" })}
              onClick={stopEventPropagation}
            >
              <ChevronDownIcon className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        )}
      </div>
      {!hideOpenWithMenu && (
        <DropdownMenuContent
          align="end"
          side="top"
          className="w-64 max-w-[calc(100vw-1rem)]"
          onClick={stopEventPropagation}
        >
          <OpenSplitButtonDropdownActions
            target={target}
            sortedEditors={sortedEditors}
            loadingEditors={loadingEditors || fileApplications.loading}
            canOpenWith={Boolean(
              platform.canOpenLocalFiles && (!isRemoteSource || openInEditorRemoteTarget),
            )}
            handleOpenExternal={handleOpenExternal}
            handleOpenInEditor={handleOpenInEditor}
            handleOpenDefault={
              canOpenNative && platform.openExternalFile ? handleOpenDefault : undefined
            }
          />
          {viewMenuItems ? (
            <>
              <DropdownMenuSeparator />
              {viewMenuItems}
            </>
          ) : null}
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
  if (!renderCard) return button;
  return (
    <ContextMenu
      onOpenChange={(open) =>
        open &&
        platform.canOpenLocalFiles &&
        (!isRemoteSource || openInEditorRemoteTarget) &&
        void loadEditors()
      }
    >
      <ContextMenuTrigger asChild>
        {renderCard(button, { handlePreview, canPreview })}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-64 max-w-[calc(100vw-1rem)]">
        {renderContextActions()}
      </ContextMenuContent>
    </ContextMenu>
  );
}

// The dropdown keeps a compact flat app list; save-copy and path actions stay directly discoverable.
function OpenSplitButtonDropdownActions({
  target,
  sortedEditors,
  loadingEditors,
  handleOpenExternal,
  handleOpenInEditor,
  handleOpenDefault,
  canOpenWith,
}: {
  target:
    | { type: "website" }
    | {
        type: "file";
        path: string;
        label: string;
        previewSource?: {
          workspacePath?: string;
          workspaceIdentity?: string;
          workspaceRemoteSessionId?: string;
        };
      };
  sortedEditors: readonly (EditorInfo & { isDefault?: boolean })[];
  loadingEditors: boolean;
  handleOpenExternal: () => void;
  handleOpenInEditor: (editor: EditorInfo) => void;
  handleOpenDefault?: () => void;
  canOpenWith: boolean;
}) {
  const { intl } = useZCodeIntl();
  const fileActions = useFileContextActions();
  return (
    <>
      {target.type === "website" ? (
        <DropdownMenuItem onSelect={handleOpenExternal}>
          <ExternalLinkIcon className="size-4" />
          <span>
            {intl.formatMessage({
              id: "chat.previewCards.openExternal",
            })}
          </span>
        </DropdownMenuItem>
      ) : (
        <>
          {(handleOpenDefault || canOpenWith) && (
            <FileApplicationChoices
              applications={sortedEditors}
              loading={loadingEditors}
              onOpenDefault={handleOpenDefault}
              onSelect={handleOpenInEditor}
            />
          )}
          {(handleOpenDefault || canOpenWith) && <DropdownMenuSeparator />}
          <FileSaveAsMenuItem path={target.path} {...target.previewSource} />
          <DropdownMenuItem
            onSelect={() => void fileActions.copyAbsolutePath({ path: target.path })}
          >
            <CopyIcon className="size-4" />
            {intl.formatMessage({ id: "fileActions.copyAbsolutePath" })}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              void fileActions.copyRelativePath({
                path: target.path,
                relativePath: target.previewSource?.workspacePath
                  ? getWorkspaceFileRelativePath(target.previewSource.workspacePath, target.path)
                  : target.label,
              })
            }
          >
            <CopyIcon className="size-4" />
            {intl.formatMessage({ id: "fileActions.copyRelativePath" })}
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}
