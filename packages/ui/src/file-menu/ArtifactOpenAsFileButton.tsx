import { useCallback, useEffect, useRef, useState } from "react";
import type { FileApplicationInfo, IPlatformService } from "@zcode/shared";
import { ChevronDownIcon, CopyIcon, DownloadIcon, FolderOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { toast } from "@/components/ui/toast.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { fileSaveSuccessMessageId, MAX_FILE_COPY_BYTES } from "@/file-menu/fileCopy.js";
import { logger } from "@/logger.js";
import { DefaultFileApplicationLabel } from "@/file-menu/DefaultFileApplicationLabel.js";
import { FileApplicationChoices } from "@/file-menu/FileApplicationChoices.js";

/**
 * The "open as file" split button in the artifact tab header (docs/dynamic-workflow/authoring.md,
 * "How the user sees them").
 *
 * ⚠ Terminology: artifact = output the script publishes to the user via `artifact.*`, not the
 * engine's `RunSettlement.artifact`.
 *
 * The file is a local copy the host writes from the exact bytes **the tab has already read**
 * (`materializeWorkflowArtifactFile`), not the file inside the CLI artifact store — rationale in
 * desktop's `workflowArtifactFile.ts`. The main button opens it with the system default app;
 * the chevron lists system-associated apps for the copy's format and can save the current
 * version, followed by location actions: "reveal in workspace" (when the artifact has a
 * locally reachable workspace origin) and "copy absolute path". "Reveal in workspace" lives
 * here so the header keeps a single file control; mobile Web, which cannot open local apps,
 * gets only the save-current-version button.
 */
interface ArtifactOpenAsFileButtonProps {
  runId: string;
  artifactId: string;
  version: number;
  /** The copy's file name (with extension; the extension decides which app the system opens it with). */
  fileName: string;
  /** The bytes of **this version**; pass null when not yet read (or when what was read belongs to another version) and the button is disabled. */
  bytes: Uint8Array | null;
  /** "Reveal in workspace": a file tree reveal with the path already bound; absent means the menu has no such entry. */
  onReveal?: () => void;
}

type MaterializeCapablePlatform = IPlatformService &
  Required<Pick<IPlatformService, "materializeWorkflowArtifactFile" | "openExternalFile">>;

function canOpenAsFile(platform: IPlatformService | null): platform is MaterializeCapablePlatform {
  return (
    platform !== null &&
    platform.materializeWorkflowArtifactFile !== undefined &&
    platform.openExternalFile !== undefined
  );
}

/** Whether the current host can provide a local open menu that includes "reveal in workspace". */
export function useCanOpenArtifactAsFile(): boolean {
  return canOpenAsFile(useOptionalPlatform());
}

/** Save capability does not imply the open menu; Web still needs its own workspace-locate entry. */
export function useCanSaveArtifactAsFile(): boolean {
  const platform = useOptionalPlatform();
  return canOpenAsFile(platform) || Boolean(platform?.saveFile);
}

export function ArtifactOpenAsFileButton(props: ArtifactOpenAsFileButtonProps) {
  const platform = useOptionalPlatform();
  if (!canOpenAsFile(platform))
    return platform?.saveFile ? <ArtifactSaveButton {...props} platform={platform} /> : null;
  return <OpenAsFileSplitButton {...props} platform={platform} />;
}

function OpenAsFileSplitButton({
  runId,
  artifactId,
  version,
  fileName,
  bytes,
  onReveal,
  platform,
}: ArtifactOpenAsFileButtonProps & { platform: MaterializeCapablePlatform }) {
  const { intl } = useZCodeIntl();
  const key = `${runId}\u0000${artifactId}\u0000${version}\u0000${fileName}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  const [applicationQuery, setApplicationQuery] = useState<{
    key: string;
    apps: FileApplicationInfo[] | null;
  } | null>(null);
  const editors = applicationQuery?.key === key ? applicationQuery.apps : null;
  const defaultApplication = editors?.find((app) => app.isDefault) ?? null;
  const query = useRef(0);
  useEffect(() => {
    setApplicationQuery(null);
    query.current += 1;
    return () => {
      query.current += 1;
    };
  }, [runId, artifactId, version, fileName]);

  // One copy path per version: reopening the same version does not re-send up to 20 MiB of bytes over
  // IPC. A promise is stored, so double-clicks also land only once; a failure evicts the cache and the
  // next click retries.
  const pathsRef = useRef(new Map<string, Promise<string>>());
  const ensureLocalPath = useCallback((): Promise<string> => {
    const key = `${runId}\u0000${artifactId}\u0000${version}\u0000${fileName}`;
    const cached = pathsRef.current.get(key);
    if (cached !== undefined) return cached;
    if (bytes === null) return Promise.reject(new Error("artifact bytes are not loaded"));
    const pending = platform
      .materializeWorkflowArtifactFile({ runId, artifactId, version, fileName, bytes })
      .then((result) => result.localPath);
    pathsRef.current.set(key, pending);
    pending.catch(() => pathsRef.current.delete(key));
    return pending;
  }, [artifactId, bytes, fileName, platform, runId, version]);

  const reportFailure = useCallback(
    (action: string, error: unknown) => {
      logger.warn("[workflow-artifacts] 作为文件打开失败", {
        action,
        artifactId,
        error: error instanceof Error ? error.message : String(error),
        runId,
        version,
      });
      toast(intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.openAsFileFailed" }));
    },
    [artifactId, intl, runId, version],
  );

  const openWith = useCallback(
    (
      action: string,
      open: (localPath: string) => Promise<{ success: boolean; error?: string }>,
    ) => {
      void ensureLocalPath()
        .then(open)
        .then((result) => {
          if (!result.success) reportFailure(action, result.error ?? "unknown-error");
        })
        .catch((error: unknown) => reportFailure(action, error));
    },
    [ensureLocalPath, reportFailure],
  );

  const handleOpenDefault = () =>
    openWith("default-app", (localPath) =>
      defaultApplication && platform.openFileWithApplication
        ? platform.openFileWithApplication(defaultApplication.id, {
            path: localPath,
            pathKind: "file",
          })
        : platform.openExternalFile(localPath),
    );

  const handleOpenInEditor = (editor: FileApplicationInfo) => {
    // The copy always lives on the host's own machine: never pass remoteTarget, even for remote
    // workspaces, or it would be treated as a remote path to open.
    openWith(`editor:${editor.id}`, (localPath) =>
      platform.openFileWithApplication!(editor.id, { path: localPath, pathKind: "file" }),
    );
  };

  const handleCopyPath = () => {
    void ensureLocalPath()
      .then((localPath) => navigator.clipboard?.writeText(localPath))
      .catch((error: unknown) => reportFailure("copy-path", error));
  };

  const loadEditors = useCallback(() => {
    const request = ++query.current;
    setApplicationQuery({ key, apps: null });
    void ensureLocalPath()
      .then((path) => platform.getFileApplications?.({ path, pathKind: "file" }) ?? [])
      .then((apps) => {
        if (request === query.current && currentKey.current === key)
          setApplicationQuery({ key, apps });
      })
      .catch((error: unknown) => {
        if (request !== query.current || currentKey.current !== key) return;
        logger.warn("[workflow-artifacts] 获取打开方式失败", { error: String(error) });
        setApplicationQuery({ key, apps: [] });
      });
  }, [ensureLocalPath, key, platform]);
  // Querying associated apps requires materializing the version copy first, so it can only be
  // triggered by user actions like opening the menu; mount, byte loading or version switches
  // must not write the artifact to the local machine just to prefetch icons.

  const disabled = bytes === null;
  const label = intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.openAsFile" });
  const chooseLabel = intl.formatMessage({ id: "appHeader.selectOpenApp" });

  return (
    <DropdownMenu onOpenChange={(open) => open && loadEditors()}>
      {/* Split shell: main action on the left, menu on the right (DESIGN.md "Composite triggers"). Height matches the header's sm buttons. */}
      <div className="flex h-6 shrink-0 items-center overflow-hidden rounded-md border border-border bg-input transition-colors hover:border-border-hover">
        <Button
          className="h-6 rounded-none border-0 pr-1.5"
          data-testid="workflow-artifact-open-as-file"
          disabled={disabled}
          title={intl.formatMessage(
            {
              id: defaultApplication
                ? "fileActions.openInApplication"
                : "chat.previewCards.openDefaultApp",
            },
            defaultApplication ? { application: defaultApplication.name } : undefined,
          )}
          aria-label={intl.formatMessage(
            {
              id: defaultApplication
                ? "fileActions.openInApplication"
                : "chat.previewCards.openDefaultApp",
            },
            defaultApplication ? { application: defaultApplication.name } : undefined,
          )}
          onClick={handleOpenDefault}
          size="sm"
          type="button"
          variant="ghost"
        >
          <DefaultFileApplicationLabel application={defaultApplication}>
            {label}
          </DefaultFileApplicationLabel>
        </Button>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={chooseLabel}
            className="!w-5 rounded-none border-0 text-foreground-subtlest"
            data-testid="workflow-artifact-open-as-file-menu"
            disabled={disabled}
            size="icon-sm"
            title={chooseLabel}
            type="button"
            variant="ghost"
          >
            <ChevronDownIcon aria-hidden="true" className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="end" className="w-64 max-w-[calc(100vw-1rem)]">
        <FileApplicationChoices
          applications={editors ?? []}
          loading={editors === null}
          onOpenDefault={handleOpenDefault}
          onSelect={handleOpenInEditor}
        />
        <DropdownMenuSeparator />
        {platform.saveFile && (
          <ArtifactSaveButton
            runId={runId}
            artifactId={artifactId}
            version={version}
            fileName={fileName}
            bytes={bytes}
            platform={platform}
            menu
          />
        )}
        <DropdownMenuSeparator />
        {onReveal === undefined ? null : (
          // Reveals the original in the workspace without materializing a copy (same path as the button that used to live in the tab header).
          <DropdownMenuItem data-testid="workflow-artifact-open-as-file-reveal" onSelect={onReveal}>
            <FolderOpenIcon aria-hidden="true" className="size-4" />
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.reveal" })}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={handleCopyPath}>
          <CopyIcon aria-hidden="true" className="size-4" />
          {intl.formatMessage({ id: "fileActions.copyAbsolutePath" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ArtifactSaveButton({
  bytes,
  fileName,
  platform,
  menu = false,
}: ArtifactOpenAsFileButtonProps & { platform: IPlatformService; menu?: boolean }) {
  const { intl } = useZCodeIntl();
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!bytes || !platform.saveFile || pending.current) return;
    pending.current = true;
    setSaving(true);
    try {
      if (bytes.byteLength > MAX_FILE_COPY_BYTES) throw new Error("file_too_large");
      // Copy the original bytes of the version the caller verified; do not re-read the workspace's latest.
      const result = await platform.saveFile({
        data: Uint8Array.from(bytes).buffer,
        suggestedName: fileName,
      });
      if (!result.success && !result.canceled) throw new Error(result.error || "save_failed");
      const messageId = fileSaveSuccessMessageId(result, platform.canOpenLocalFiles);
      if (messageId) toast(intl.formatMessage({ id: messageId }));
    } catch (error) {
      logger.warn("[workflow-artifacts] 保存产物副本失败", { error: String(error) });
      toast(
        intl.formatMessage({
          id:
            error instanceof Error && error.message === "file_too_large"
              ? "fileActions.saveAsTooLarge"
              : "fileActions.saveAsFailed",
        }),
      );
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  const content = (
    <>
      <DownloadIcon className="size-4" />
      {intl.formatMessage({ id: "fileActions.saveAs" })}
    </>
  );
  return menu ? (
    <DropdownMenuItem disabled={bytes === null || saving} onSelect={() => void save()}>
      {content}
    </DropdownMenuItem>
  ) : (
    <Button
      variant="ghost"
      size="sm"
      disabled={bytes === null || saving}
      onClick={() => void save()}
      data-testid="workflow-artifact-save-as"
    >
      {content}
    </Button>
  );
}
