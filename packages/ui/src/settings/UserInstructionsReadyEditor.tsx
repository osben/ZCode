import { useCallback } from "react";
import { FolderOpen, Import, Save, Undo2 } from "lucide-react";
import {
  TID_SETTINGS_INSTRUCTIONS_DISCARD,
  TID_SETTINGS_INSTRUCTIONS_EDITOR,
  TID_SETTINGS_INSTRUCTIONS_IMPORT,
  TID_SETTINGS_INSTRUCTIONS_REVEAL,
  TID_SETTINGS_INSTRUCTIONS_SAVE,
  TID_SETTINGS_INSTRUCTIONS_TAB_EDIT,
  TID_SETTINGS_INSTRUCTIONS_TAB_PREVIEW,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { Textarea } from "@/components/ui/textarea.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import type { UserInstructionsEditor } from "@/hooks/useUserInstructionsEditor.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { MarkdownPreviewContent } from "@/previewPaneMarkdownContent.js";
import {
  estimateUserInstructionsDiskBytes,
  formatUserInstructionsBytes,
  getUserInstructionsRevealDirectory,
} from "@/settings/userInstructionsEditorModel.js";
import { useZCodeStore } from "@/store/StoreProvider.js";

export function UserInstructionsRevealButton({
  filePath,
  disabled,
}: {
  filePath: string;
  disabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const handleReveal = useCallback(async () => {
    const result = await platform.openInFileManager(getUserInstructionsRevealDirectory(filePath));
    if (!result.success) {
      toast(intl.formatMessage({ id: "appHeader.openInFileManagerFailed" }));
    }
  }, [filePath, intl, platform]);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={() => void handleReveal()}
      data-testid={TID_SETTINGS_INSTRUCTIONS_REVEAL}
    >
      <FolderOpen className="size-4" />
      {intl.formatMessage({ id: "settings.instructions.reveal" })}
    </Button>
  );
}

export function UserInstructionsReadyEditor({ editor }: { editor: UserInstructionsEditor }) {
  const { intl } = useZCodeIntl();
  const theme = useZCodeStore((state) => state.theme);
  const codePreviewSettings = useZCodeStore((state) => state.codePreviewSettings);
  const loaded = editor.loaded;
  if (!loaded) return null;
  const diskBytes = estimateUserInstructionsDiskBytes({
    draft: editor.draft,
    eol: loaded.eol,
    hasBom: loaded.hasBom,
  });
  const overAgentLimit = diskBytes > loaded.agentReadLimitBytes;
  const busy = editor.saving;

  return (
    <div className="space-y-3">
      {loaded.state === "missing" ? (
        <p className="text-ui-base leading-6 text-foreground-subtle">
          {intl.formatMessage({ id: "settings.instructions.missingHint" })}
        </p>
      ) : null}
      {loaded.mixedLineEndings ? (
        <p className="text-ui-sm leading-5 text-foreground-subtle">
          {intl.formatMessage(
            { id: "settings.instructions.mixedLineEndings" },
            { eol: loaded.eol === "crlf" ? "CRLF" : "LF" },
          )}
        </p>
      ) : null}
      {loaded.linkTarget ? (
        <p className="text-ui-sm leading-5 text-foreground-subtle">
          {intl.formatMessage({ id: "settings.instructions.linkDuplicateHint" })}
        </p>
      ) : null}
      <Tabs defaultValue="edit">
        <TabsList>
          <TabsTrigger value="edit" data-testid={TID_SETTINGS_INSTRUCTIONS_TAB_EDIT}>
            {intl.formatMessage({ id: "settings.instructions.tab.edit" })}
          </TabsTrigger>
          <TabsTrigger value="preview" data-testid={TID_SETTINGS_INSTRUCTIONS_TAB_PREVIEW}>
            {intl.formatMessage({ id: "settings.instructions.tab.preview" })}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="edit">
          <Textarea
            value={editor.draft}
            onChange={(event) => editor.setDraft(event.target.value)}
            onKeyDown={(event) => {
              // 编辑器内 Cmd/Ctrl+S 与保存按钮等价，门控一致（canSave）。
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                if (editor.canSave) void editor.save();
              }
            }}
            spellCheck={false}
            disabled={busy}
            placeholder={intl.formatMessage({ id: "settings.instructions.placeholder" })}
            className="min-h-80 w-full font-mono text-ui-base"
            aria-label={intl.formatMessage({ id: "settings.instructions.editorLabel" })}
            data-testid={TID_SETTINGS_INSTRUCTIONS_EDITOR}
          />
        </TabsContent>
        <TabsContent value="preview">
          {/* 不传 workspacePath / selectionTarget：远端文档的相对链接不能解析到本机。 */}
          <div className="max-h-[60vh] min-h-80 overflow-hidden rounded-lg border border-border">
            {editor.draft.trim() ? (
              <MarkdownPreviewContent
                content={editor.draft}
                theme={theme}
                codePreviewSettings={codePreviewSettings}
              />
            ) : (
              <p className="p-4 text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "settings.instructions.previewEmpty" })}
              </p>
            )}
          </div>
        </TabsContent>
      </Tabs>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-sm text-foreground-subtle">
        <span>
          {intl.formatMessage(
            { id: "settings.instructions.size" },
            {
              size: formatUserInstructionsBytes(diskBytes),
              limit: formatUserInstructionsBytes(loaded.agentReadLimitBytes),
            },
          )}
        </span>
        {overAgentLimit ? (
          <span className="text-warning">
            {intl.formatMessage(
              { id: "settings.instructions.overAgentLimit" },
              { limit: formatUserInstructionsBytes(loaded.agentReadLimitBytes) },
            )}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="default"
          size="sm"
          disabled={!editor.canSave}
          onClick={() => void editor.save()}
          data-testid={TID_SETTINGS_INSTRUCTIONS_SAVE}
        >
          <Save className="size-4" />
          {intl.formatMessage({ id: "settings.instructions.save" })}
        </Button>
        {editor.claudeImportAvailable ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void editor.importFromClaude()}
            data-testid={TID_SETTINGS_INSTRUCTIONS_IMPORT}
          >
            <Import className="size-4" />
            {intl.formatMessage({ id: "settings.instructions.import.action" })}
          </Button>
        ) : null}
        {!editor.isRemote && loaded.state === "file" ? (
          <UserInstructionsRevealButton
            filePath={loaded.linkTarget ?? loaded.path}
            disabled={busy}
          />
        ) : null}
        {editor.dirty ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => editor.setDraft(loaded.content)}
              data-testid={TID_SETTINGS_INSTRUCTIONS_DISCARD}
            >
              <Undo2 className="size-4" />
              {intl.formatMessage({ id: "settings.instructions.discardChanges" })}
            </Button>
            <span className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.instructions.unsaved" })}
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}
