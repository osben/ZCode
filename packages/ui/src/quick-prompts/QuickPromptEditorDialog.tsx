/**
 * Quick prompt editor dialog (rules 15-16): name, body (the composer's prompt editor without quick prompts in
 * its "/" panel), scope, Duplicate and Delete. A global quick prompt opened from a session shows the global banner.
 */
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type {
  IQuickPromptService,
  QuickPrompt,
  QuickPromptColor,
  QuickPromptProjectRef,
  QuickPromptScope,
  QuickPromptSnapshot,
} from "./contract.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ChatPromptEditor } from "@/prompt-editor/ChatPromptEditor.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import type { SerializedPromptBody } from "@/prompt-body/index.js";
import { logger } from "@/logger.js";
import { QuickPromptColorPicker } from "@/quick-prompts/QuickPromptColorPicker.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import {
  isQuickPromptBodyPresent,
  isQuickPromptBodyWithinLimit,
  isValidQuickPromptName,
  quickPromptBlockMessageId,
  quickPromptErrorMessageId,
  quickPromptScopeBlocks,
  toPortableGlobalBody,
} from "@/quick-prompts/model.js";

export type QuickPromptEditorTarget =
  | {
      mode: "create";
      scope: QuickPromptScope;
      initialName?: string;
      initialBody?: SerializedPromptBody;
    }
  | { mode: "edit"; prompt: QuickPrompt };

export interface QuickPromptEditorDialogProps {
  target: QuickPromptEditorTarget;
  onClose: () => void;
  project: QuickPromptProjectRef | null;
  projectName?: string;
  snapshot: QuickPromptSnapshot;
  service: IQuickPromptService;
  refresh: () => Promise<void>;
  workspacePath: string;
  workspaceIdentity?: string;
  /**
   * False when the project's root is not the window's own project: its `@` panel would search the local filesystem,
   * so the panel is off and the hint explains where file mentions come from. Existing mention chips stay.
   */
  mentionPanelEnabled?: boolean;
}

/** Stored body state: Save writes the body only after the stored nodes loaded into the editor. */
type BodyLoadState = "pending" | "loaded" | "failed";

export function QuickPromptEditorDialog({
  target,
  onClose,
  project,
  projectName,
  snapshot,
  service,
  refresh,
  workspacePath,
  workspaceIdentity,
  mentionPanelEnabled = true,
}: QuickPromptEditorDialogProps) {
  const { intl } = useZCodeIntl();
  const editing = target.mode === "edit" ? target.prompt : null;
  const initialName = editing?.name ?? (target.mode === "create" ? (target.initialName ?? "") : "");
  const initialScope: QuickPromptScope =
    editing?.scope ?? (target.mode === "create" ? target.scope : "project");
  const initialBodyNodes =
    editing?.body.nodes ?? (target.mode === "create" ? target.initialBody?.nodes : undefined);
  const [name, setName] = useState(initialName);
  const [scope, setScope] = useState<QuickPromptScope>(initialScope);
  const initialColor = editing?.color ?? null;
  const [color, setColor] = useState<QuickPromptColor | null>(initialColor);
  const colorChanged = color !== initialColor;
  const [bodyMarkdown, setBodyMarkdown] = useState(editing?.body.markdown ?? "");
  // An empty editor is not the stored body: until the load succeeds, Save may not write a body at all.
  const [bodyLoad, setBodyLoad] = useState<BodyLoadState>(initialBodyNodes ? "pending" : "loaded");
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputApiRef: MutableRefObject<LexicalChatInputHandle | null> = useRef(null);
  const [panelContainer, setPanelContainer] = useState<HTMLDivElement | null>(null);

  // Load the stored body once the editor exists. The editor mounts with the dialog and its root may be ready a frame
  // later, so the load waits for the editor handle, a few frames at most, before reporting a failure.
  useEffect(() => {
    if (!initialBodyNodes) return;
    let frame = 0;
    const attempt = (framesLeft: number) => {
      const handle = inputApiRef.current;
      if (!handle) {
        if (framesLeft > 0) {
          frame = requestAnimationFrame(() => attempt(framesLeft - 1));
        } else {
          logger.warn("[quick-prompts] the body editor never became ready");
          setBodyLoad("failed");
        }
        return;
      }
      try {
        handle.loadSerializedBody(initialBodyNodes);
        setBodyMarkdown(handle.getSerializedBody().markdown);
        setBodyLoad("loaded");
      } catch (cause) {
        // The stored nodes could not be rebuilt (for example an unknown node type). The body and the name never
        // reach the log; the failure only blocks body writes.
        logger.warn("[quick-prompts] failed to load the stored body into the editor", cause);
        setBodyLoad("failed");
      }
    };
    frame = requestAnimationFrame(() => attempt(10));
    return () => cancelAnimationFrame(frame);
  }, [initialBodyNodes]);

  const body = (): SerializedPromptBody | null => inputApiRef.current?.getSerializedBody() ?? null;
  const currentBody = body();
  const bodyNodesForCheck = currentBody?.nodes ?? initialBodyNodes ?? null;
  const blocks = quickPromptScopeBlocks({
    scope,
    project,
    bodyNodes: bodyNodesForCheck,
    snapshot,
  });
  const bodyLength = bodyMarkdown.length;
  const bodyFailed = bodyLoad === "failed";
  const bodyWritable =
    bodyLoad === "loaded" &&
    isQuickPromptBodyPresent(bodyMarkdown) &&
    blocks.length === 0 &&
    isQuickPromptBodyWithinLimit(bodyMarkdown) &&
    !(scope === "project" && !project);
  // Rename-only path after a failed load: the stored body stays untouched, so the scope cannot change either.
  const nameOnlySavable =
    editing !== null &&
    bodyFailed &&
    isValidQuickPromptName(name) &&
    (name.trim() !== editing.name || colorChanged);
  const canSave = !busy && isValidQuickPromptName(name) && (bodyWritable || nameOnlySavable);

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      if (editing && bodyFailed) {
        await service.update({
          promptId: editing.promptId,
          name: name.trim(),
          ...(colorChanged ? { color } : {}),
        });
        await refresh();
        onClose();
        return;
      }
      const next = body();
      if (!next || !bodyWritable || !isQuickPromptBodyPresent(next.markdown)) return;
      if (editing) {
        await service.update({
          promptId: editing.promptId,
          name: name.trim(),
          body: scope === "global" ? toPortableGlobalBody(next) : next,
          // Sent only when the picker changed it, so a stored value this build cannot read is never overwritten.
          ...(colorChanged ? { color } : {}),
          scope,
          project: scope === "project" ? project : null,
        });
      } else {
        await service.create({
          scope,
          project: scope === "project" ? project : null,
          name: name.trim(),
          body: scope === "global" ? toPortableGlobalBody(next) : next,
          color,
          pinned: true,
        });
      }
      await refresh();
      onClose();
    } catch (cause) {
      logger.warn("[quick-prompts] save failed", cause);
      setError(
        intl.formatMessage({
          id: quickPromptErrorMessageId(cause, "quickPrompts.errors.save"),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async (
    targetScope: QuickPromptScope,
    targetProject: QuickPromptProjectRef | null,
    pinCopy: boolean,
  ) => {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      const copy = await service.duplicate({
        promptId: editing.promptId,
        scope: targetScope,
        project: targetProject,
      });
      if (pinCopy) await service.setPinned({ promptId: copy.promptId, pinned: true });
      await refresh();
      onClose();
    } catch (cause) {
      logger.warn("[quick-prompts] duplicate failed", cause);
      setError(
        intl.formatMessage({
          id: quickPromptErrorMessageId(cause, "quickPrompts.errors.duplicate"),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing) return;
    const confirmed = await useConfirmDialogStore.getState().requestConfirmation({
      title: intl.formatMessage({
        id:
          editing.scope === "global"
            ? "quickPrompts.confirm.deleteEverywhere.title"
            : "quickPrompts.confirm.delete.title",
      }),
      description: intl.formatMessage({
        id:
          editing.scope === "global"
            ? "quickPrompts.confirm.deleteEverywhere.description"
            : "quickPrompts.confirm.delete.description",
      }),
      confirmLabel: intl.formatMessage({ id: "quickPrompts.confirm.delete" }),
      confirmVariant: "destructive",
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await service.delete({ promptId: editing.promptId });
      await refresh();
      onClose();
    } catch (cause) {
      logger.warn("[quick-prompts] delete failed", cause);
      setError(intl.formatMessage({ id: "quickPrompts.errors.action" }));
    } finally {
      setBusy(false);
    }
  };

  const showGlobalBanner = editing?.scope === "global" && project !== null && !bannerDismissed;

  const scopeButton = (candidate: QuickPromptScope) => (
    <Button
      type="button"
      variant={scope === candidate ? "secondary" : "outline"}
      size="sm"
      aria-pressed={scope === candidate}
      data-testid={`quick-prompt-editor-scope-${candidate}`}
      disabled={
        busy ||
        bodyFailed ||
        quickPromptScopeBlocks({
          scope: candidate,
          project,
          bodyNodes: bodyNodesForCheck,
          snapshot,
        }).length > 0
      }
      onClick={() => setScope(candidate)}
    >
      {intl.formatMessage({
        id: candidate === "project" ? "quickPrompts.scope.project" : "quickPrompts.scope.global",
      })}
    </Button>
  );

  const blockedMessageId = blocks[0] ? quickPromptBlockMessageId(blocks[0]) : null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-3 overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({
              id: editing ? "quickPrompts.editor.title.edit" : "quickPrompts.editor.title.create",
            })}
          </DialogTitle>
        </DialogHeader>
        {showGlobalBanner ? (
          <div
            role="status"
            data-testid="quick-prompt-banner-global"
            className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3 text-ui-base"
          >
            <p className="text-foreground-subtle">
              {intl.formatMessage({ id: "quickPrompts.banner.global" })}
            </p>
            <div className="flex flex-wrap gap-2">
              {projectName && project ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void duplicate("project", project, true)}
                >
                  {intl.formatMessage(
                    { id: "quickPrompts.banner.duplicateTo" },
                    { project: projectName },
                  )}
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setBannerDismissed(true)}
              >
                {intl.formatMessage({
                  id: "quickPrompts.banner.editEverywhere",
                })}
              </Button>
            </div>
          </div>
        ) : null}
        <label className="flex flex-col gap-1 text-ui-base">
          <span className="text-ui-caption text-foreground-subtle">
            {intl.formatMessage({ id: "quickPrompts.editor.name" })}
          </span>
          <Input
            value={name}
            maxLength={200}
            data-testid="quick-prompt-editor-name"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-ui-caption text-foreground-subtle">
            {intl.formatMessage({ id: "quickPrompts.editor.color" })}
          </span>
          <QuickPromptColorPicker value={color} onChange={setColor} disabled={busy} />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-ui-caption text-foreground-subtle">
            {intl.formatMessage({ id: "quickPrompts.editor.scope" })}
          </span>
          <div className="flex gap-2">
            {scopeButton("project")}
            {scopeButton("global")}
          </div>
          {blockedMessageId ? (
            <p role="status" className="text-ui-caption text-foreground-subtle">
              {intl.formatMessage({ id: blockedMessageId })}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-ui-caption text-foreground-subtle">
            {intl.formatMessage({ id: "quickPrompts.editor.body" })}
          </span>
          {bodyFailed ? (
            <p
              role="alert"
              data-testid="quick-prompt-editor-load-error"
              className="text-ui-caption text-destructive"
            >
              {intl.formatMessage({ id: "quickPrompts.editor.bodyLoadFailed" })}
            </p>
          ) : null}
          {mentionPanelEnabled ? null : (
            <p
              role="status"
              data-testid="quick-prompt-editor-mentions-hint"
              className="text-ui-caption text-foreground-subtle"
            >
              {intl.formatMessage({
                id: "quickPrompts.editor.mentionsUnavailable",
              })}
            </p>
          )}
          {/* Panels portal into this container so the dialog's scroll area never clips them. */}
          <div ref={setPanelContainer} className="relative" />
          <ChatPromptEditor
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            taskId={null}
            syncInitialValueOnMount={false}
            inputApiRef={inputApiRef}
            inputTestId="quick-prompt-editor-body"
            triggerPanelContainer={panelContainer}
            enterSubmits={false}
            submitLabel={intl.formatMessage({ id: "quickPrompts.editor.save" })}
            hideSubmit
            onChange={setBodyMarkdown}
            onSubmit={() => {
              void save();
            }}
            submitDisabled={!canSave}
            showMentionButton={mentionPanelEnabled}
            showSlashButton
            enableMentionPanel={mentionPanelEnabled}
            placeholder={intl.formatMessage({
              id: "quickPrompts.editor.body.placeholder",
            })}
          />
          <p className="text-ui-caption text-foreground-subtlest">
            {intl.formatMessage(
              { id: "quickPrompts.editor.bodyCount" },
              { count: bodyLength, limit: 8000 },
            )}
          </p>
        </div>
        {error ? (
          <p role="alert" className="text-ui-caption text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter className="flex flex-wrap items-center justify-between gap-2">
          {editing ? (
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void duplicate(editing.scope, editing.project, false)}
              >
                {intl.formatMessage({ id: "quickPrompts.editor.duplicate" })}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void remove()}
              >
                {intl.formatMessage({ id: "quickPrompts.editor.delete" })}
              </Button>
            </div>
          ) : (
            <span />
          )}
          <Button
            type="button"
            size="sm"
            data-testid="quick-prompt-editor-save"
            disabled={!canSave}
            onClick={() => void save()}
          >
            {intl.formatMessage({ id: "quickPrompts.editor.save" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
