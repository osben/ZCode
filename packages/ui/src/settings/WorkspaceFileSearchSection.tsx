import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, RotateCcw, Save, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import { logger } from "@/logger.js";

interface WorkspaceFileSearchSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
}

type IgnoreFileState = {
  content: string;
  source: "file" | "template";
};

/** Workspace file-search ignore-rule (.zcodeignore) editor. The rules file is the single source of truth for directory exclusions: saving takes effect on the next scan. “Sync from .gitignore” and “Restore defaults” are section operations that rewrite only their marked areas (the gitignore-sync area / default-exclusion block); custom user rules are untouched. Results populate the editor and still require saving to reach disk. */
export function WorkspaceFileSearchSection({
  workspacePath,
  workspaceIdentity,
}: WorkspaceFileSearchSectionProps) {
  // Without a workspace, show a hint directly and do not mount the workspace-service hook chain (same layered pattern as SessionPluginReferenceIconBoundary),
  // avoiding unnecessary dependencies on services/tabStore context.
  if (!workspacePath) {
    return <NoWorkspaceFileSearchHint />;
  }
  return (
    <ActiveWorkspaceFileSearchEditor
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
    />
  );
}

function NoWorkspaceFileSearchHint() {
  const { intl } = useZCodeIntl();
  return (
    <p className="text-ui-base leading-6 text-foreground-subtle">
      {intl.formatMessage({ id: "settings.workspaceFileSearch.noWorkspace" })}
    </p>
  );
}

function ActiveWorkspaceFileSearchEditor({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const resolution = useWorkspaceServicesResolution(workspacePath, undefined, workspaceIdentity);
  const services = resolution.services;
  const rpcReady = resolution.rpcReady;

  const [loaded, setLoaded] = useState<IgnoreFileState | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const loadVersionRef = useRef(0);

  const load = useCallback(async () => {
    if (!workspacePath || !rpcReady) {
      return;
    }
    const version = loadVersionRef.current + 1;
    loadVersionRef.current = version;
    setLoading(true);
    try {
      const result = await services.fileService.readWorkspaceFileSearchIgnore({
        rootPath: workspacePath,
      });
      if (loadVersionRef.current !== version) {
        return;
      }
      setLoaded({ content: result.content, source: result.source });
      setDraft(result.content);
    } catch (error) {
      if (loadVersionRef.current !== version) {
        return;
      }
      logger.warn("[WorkspaceFileSearchSection] 读取 .zcodeignore 失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "settings.workspaceFileSearch.loadFailed" }));
    } finally {
      if (loadVersionRef.current === version) {
        setLoading(false);
      }
    }
  }, [intl, rpcReady, services, workspacePath]);

  // Section operations rewrite only their corresponding marked area (sync-gitignore rewrites the gitignore-sync section; reset-defaults
  // resets the default-exclusion block). Custom user rules remain untouched; the result fills the editor and is saved only on explicit save.
  const applyTransform = useCallback(
    async (transform: "sync-gitignore" | "reset-defaults") => {
      if (!workspacePath || !rpcReady) {
        return;
      }
      const version = loadVersionRef.current + 1;
      loadVersionRef.current = version;
      try {
        const result = await services.fileService.applyWorkspaceFileSearchIgnoreTransform({
          rootPath: workspacePath,
          transform,
        });
        if (loadVersionRef.current !== version) {
          return;
        }
        // Update only editor content; keep loaded unchanged. Dirty state follows naturally from the content difference.
        setDraft(result.content);
      } catch (error) {
        if (loadVersionRef.current !== version) {
          return;
        }
        logger.warn("[WorkspaceFileSearchSection] 应用 .zcodeignore 分区操作失败", {
          transform,
          error: error instanceof Error ? error.message : String(error),
        });
        toast(intl.formatMessage({ id: "settings.workspaceFileSearch.transformFailed" }));
      }
    },
    [intl, rpcReady, services, workspacePath],
  );

  useEffect(() => {
    if (!workspacePath || !rpcReady) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoaded(null);
    setDraft("");
    void load();
    // load depends on workspace/services; reset before fetching when the workspace changes.
  }, [load, rpcReady, workspacePath]);

  const handleSave = useCallback(async () => {
    if (!workspacePath) {
      return;
    }
    setSaving(true);
    try {
      await services.fileService.writeWorkspaceFileSearchIgnore({
        rootPath: workspacePath,
        content: draft,
      });
      setLoaded({ content: draft, source: "file" });
      toast(intl.formatMessage({ id: "settings.workspaceFileSearch.saved" }));
    } catch (error) {
      logger.warn("[WorkspaceFileSearchSection] 保存 .zcodeignore 失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "settings.workspaceFileSearch.saveFailed" }));
    } finally {
      setSaving(false);
    }
  }, [draft, intl, services, workspacePath]);

  // Save means “write the editor contents to disk”: in template state (.zcodeignore does not yet exist), allow saving even if untouched,
  // otherwise users could never create the file on their first visit without making an edit. Once persisted, require changes to enable save.
  const canSave = loaded === null || loaded.source === "template" || draft !== loaded.content;
  // The “unsaved changes” hint reports only real differences (hide it for an untouched template).
  const dirty = loaded !== null && loaded.source === "file" && draft !== loaded.content;

  // “Open file location”: .zcodeignore is at the workspace root, so opening the root opens its location
  // (following the WindowsCaptionMenuButton/ModelTrajectoryPane precedent of passing a directory).
  // Remote workspace rules live on the remote machine, so the local file manager cannot open them; hide this button.
  const isLocalWorkspace = !workspaceIdentity?.trim();
  const revealTargetReady = loaded?.source === "file";
  const handleReveal = useCallback(async () => {
    const result = await platform.openInFileManager(workspacePath);
    if (!result.success) {
      toast(intl.formatMessage({ id: "appHeader.openInFileManagerFailed" }));
    }
  }, [intl, platform, workspacePath]);

  return (
    // Match the settings-page layout standard: introduction + SettingsGroupCard card,
    // use text-ui-base throughout; keep the textarea monospace because its contents are rule text.
    <div className="space-y-3">
      <div className="text-ui-base font-medium text-foreground-subtle">
        {intl.formatMessage({ id: "settings.workspaceFileSearch.description" })}
      </div>
      <SettingsGroupCard>
        <div className="space-y-3 px-4 py-3">
          {loaded?.source === "template" ? (
            <div className="text-ui-base leading-6 text-foreground-subtle">
              {intl.formatMessage({ id: "settings.workspaceFileSearch.templateHint" })}
            </div>
          ) : null}
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Save shortcut: Ctrl/Cmd+S in the editor is equivalent to clicking Save (preventDefault
              // blocks browser behavior); use the same gating as the button (canSave).
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                if (canSave && !saving && !loading) {
                  void handleSave();
                }
              }
            }}
            spellCheck={false}
            disabled={loading || saving}
            className="min-h-64 w-full font-mono text-ui-base"
            aria-label={intl.formatMessage({ id: "settings.workspaceFileSearch.editorLabel" })}
            data-testid="workspace-file-search-ignore-editor"
          />
          <div className="flex items-center gap-2">
            <Button
              variant="default"
              size="sm"
              disabled={!canSave || saving || loading}
              onClick={() => void handleSave()}
              data-testid="workspace-file-search-ignore-save"
            >
              <Save className="size-4" />
              {intl.formatMessage({ id: "settings.workspaceFileSearch.save" })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={loading || saving}
              onClick={() => void applyTransform("sync-gitignore")}
              data-testid="workspace-file-search-ignore-resync"
            >
              <RotateCcw className="size-4" />
              {intl.formatMessage({ id: "settings.workspaceFileSearch.resync" })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={loading || saving}
              onClick={() => void applyTransform("reset-defaults")}
              data-testid="workspace-file-search-ignore-restore-defaults"
            >
              <Undo2 className="size-4" />
              {intl.formatMessage({ id: "settings.workspaceFileSearch.restoreDefaults" })}
            </Button>
            {isLocalWorkspace ? (
              <Button
                variant="outline"
                size="sm"
                disabled={!revealTargetReady || loading || saving}
                title={
                  revealTargetReady
                    ? undefined
                    : intl.formatMessage({ id: "settings.workspaceFileSearch.revealHint" })
                }
                onClick={() => void handleReveal()}
                data-testid="workspace-file-search-ignore-reveal"
              >
                <FolderOpen className="size-4" />
                {intl.formatMessage({ id: "settings.workspaceFileSearch.reveal" })}
              </Button>
            ) : null}
            {dirty ? (
              <span className="text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "settings.workspaceFileSearch.unsaved" })}
              </span>
            ) : null}
          </div>
        </div>
      </SettingsGroupCard>
    </div>
  );
}
