import { useCallback, useRef, useState } from "react";
import type { EditorInfo, IPlatformService } from "@zcode/shared";
import { ChevronDownIcon, CopyIcon, ExternalLinkIcon, FolderOpenIcon } from "lucide-react";
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
import { persistLastSelectedEditorId } from "@/lib/editorPreference.js";
import { sortInstalledEditorsForOpenWith } from "@/lib/openWithEditors.js";
import { logger } from "@/logger.js";

/**
 * The "open as file" split button in the artifact tab header (docs/dynamic-workflow/authoring.md,
 * "How the user sees them").
 *
 * ⚠ Terminology: artifact = output the script publishes to the user via `artifact.*`, not the
 * engine's `RunSettlement.artifact`.
 *
 * The file is a local copy the host writes from the bytes of the version **the tab has already
 * read** (`materializeWorkflowArtifactFile`), not the file in the CLI artifact store — rationale in
 * desktop's `workflowArtifactFile.ts`. The main button opens it with the system default app; the
 * chevron lists installed apps (the same list and preference as other "open with" menus, file
 * managers first), followed by location actions: "reveal in workspace" (when the artifact has a
 * locally reachable workspace provenance) and "copy absolute path".
 * "Reveal in workspace" is folded in here so the header keeps a single file control; when the host
 * cannot materialize a copy (mobile remote, plain web), the whole button is absent and the caller
 * uses {@link useCanOpenArtifactAsFile} to put "reveal in workspace" back into the header.
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

/** Whether the current host can "open as file" — the header uses this to decide whether "reveal in workspace" goes into the menu or becomes its own button. */
export function useCanOpenArtifactAsFile(): boolean {
  return canOpenAsFile(useOptionalPlatform());
}

export function ArtifactOpenAsFileButton(props: ArtifactOpenAsFileButtonProps) {
  const platform = useOptionalPlatform();
  if (!canOpenAsFile(platform)) return null;
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
  const [editors, setEditors] = useState<EditorInfo[] | null>(null);

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
    openWith("default-app", (localPath) => platform.openExternalFile(localPath));

  const handleOpenInEditor = (editor: EditorInfo) => {
    persistLastSelectedEditorId(editor.id);
    // The copy always lives on the host's own machine: never pass remoteTarget, even for remote
    // workspaces, or it would be treated as a remote path to open.
    openWith(`editor:${editor.id}`, (localPath) =>
      platform.openInEditor(editor.id, localPath, { pathKind: "file" }),
    );
  };

  const handleCopyPath = () => {
    void ensureLocalPath()
      .then((localPath) => navigator.clipboard?.writeText(localPath))
      .catch((error: unknown) => reportFailure("copy-path", error));
  };

  const loadEditors = () => {
    if (editors !== null) return;
    void platform
      .getInstalledEditors()
      .then((installed) => setEditors(sortInstalledEditorsForOpenWith(installed)))
      .catch((error: unknown) => {
        logger.warn("[workflow-artifacts] 获取打开方式失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        setEditors([]);
      });
  };

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
          onClick={handleOpenDefault}
          size="sm"
          type="button"
          variant="ghost"
        >
          <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
          {label}
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
      <DropdownMenuContent align="end" className="w-48">
        {editors === null || editors.length === 0 ? (
          <DropdownMenuItem disabled>
            {intl.formatMessage({
              id: editors === null ? "common.loading" : "chat.previewCards.noOpenApps",
            })}
          </DropdownMenuItem>
        ) : (
          editors.map((editor) => (
            <DropdownMenuItem key={editor.id} onSelect={() => handleOpenInEditor(editor)}>
              <img alt="" className="size-4 shrink-0" src={editor.iconDataUrl} />
              <span className="truncate">{editor.name}</span>
            </DropdownMenuItem>
          ))
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
