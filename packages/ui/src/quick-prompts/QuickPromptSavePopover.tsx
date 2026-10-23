/**
 * "Save draft" popover (rule 14): name prefilled from the draft, scope, and a "More options…" path to the editor.
 * The content is the draft exactly as typed, mentions included, read from the editor handle at save time.
 */
import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import type {
  IQuickPromptService,
  QuickPromptProjectRef,
  QuickPromptScope,
  QuickPromptSnapshot,
} from "./contract.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import type { SerializedPromptBody } from "@/prompt-body/index.js";
import { logger } from "@/logger.js";
import type { QuickPromptEditorTarget } from "@/quick-prompts/QuickPromptEditorDialog.js";
import {
  defaultQuickPromptScope,
  isQuickPromptBodyPresent,
  isQuickPromptBodyWithinLimit,
  isValidQuickPromptName,
  prefillQuickPromptName,
  quickPromptBlockMessageId,
  quickPromptScopeBlocks,
  toPortableGlobalBody,
} from "@/quick-prompts/model.js";

export interface QuickPromptSavePopoverProps {
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  service: IQuickPromptService;
  project: QuickPromptProjectRef | null;
  snapshot: QuickPromptSnapshot;
  inputApiRef: MutableRefObject<LexicalChatInputHandle | null>;
  refresh: () => Promise<void>;
  onMoreOptions: (target: QuickPromptEditorTarget) => void;
}

export function QuickPromptSavePopover({
  children,
  open,
  onOpenChange,
  service,
  project,
  snapshot,
  inputApiRef,
  refresh,
  onMoreOptions,
}: QuickPromptSavePopoverProps) {
  const { intl } = useZCodeIntl();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<QuickPromptScope>("project");
  const [body, setBody] = useState<SerializedPromptBody | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Snapshot the draft once, when the popover opens. Later snapshot updates must not reset what the user typed,
  // so the open effect reads the latest project and snapshot through a ref instead of depending on them.
  const latestRef = useRef({ project, snapshot });
  latestRef.current = { project, snapshot };
  useEffect(() => {
    if (!open) return;
    const { project: openProject, snapshot: openSnapshot } = latestRef.current;
    const current = inputApiRef.current?.getSerializedBody() ?? null;
    setBody(current);
    setName(current ? prefillQuickPromptName(current.markdown) : "");
    setError(null);
    const preferred = defaultQuickPromptScope(openProject);
    const blocked = (candidate: QuickPromptScope) =>
      quickPromptScopeBlocks({
        scope: candidate,
        project: openProject,
        bodyNodes: current?.nodes ?? null,
        snapshot: openSnapshot,
      }).length > 0;
    const other: QuickPromptScope = preferred === "project" ? "global" : "project";
    setScope(blocked(preferred) && !blocked(other) ? other : preferred);
  }, [open, inputApiRef]);

  const blocksFor = (candidate: QuickPromptScope) =>
    quickPromptScopeBlocks({ scope: candidate, project, bodyNodes: body?.nodes ?? null, snapshot });
  const scopeBlocks = blocksFor(scope);
  const bodyTooLong = body ? !isQuickPromptBodyWithinLimit(body.markdown) : false;
  const canSave =
    body !== null &&
    isQuickPromptBodyPresent(body.markdown) &&
    isValidQuickPromptName(name) &&
    scopeBlocks.length === 0 &&
    !bodyTooLong &&
    !saving;

  const save = async () => {
    if (!body || !canSave) return;
    setSaving(true);
    setError(null);
    try {
      await service.create({
        scope,
        project: scope === "project" ? project : null,
        name: name.trim(),
        body: scope === "global" ? toPortableGlobalBody(body) : body,
        pinned: true,
      });
      await refresh();
      onOpenChange(false);
    } catch (cause) {
      // Name and body never reach the log.
      logger.warn("[quick-prompts] save draft failed", cause);
      setError(intl.formatMessage({ id: "quickPrompts.errors.save" }));
    } finally {
      setSaving(false);
    }
  };

  const scopeButton = (candidate: QuickPromptScope) => {
    const blocks = blocksFor(candidate);
    const disabled = blocks.length > 0;
    return (
      <Button
        type="button"
        variant={scope === candidate ? "secondary" : "outline"}
        size="sm"
        aria-pressed={scope === candidate}
        disabled={disabled}
        data-testid={`quick-prompt-save-scope-${candidate}`}
        onClick={() => setScope(candidate)}
      >
        {intl.formatMessage({
          id: candidate === "project" ? "quickPrompts.scope.project" : "quickPrompts.scope.global",
        })}
      </Button>
    );
  };

  const explanationId = scopeBlocks[0]
    ? quickPromptBlockMessageId(scopeBlocks[0])
    : bodyTooLong
      ? "quickPrompts.errors.bodyTooLong"
      : null;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3">
        <div className="flex flex-col gap-3 text-ui-base">
          <label className="flex flex-col gap-1">
            <span className="text-ui-caption text-foreground-subtle">
              {intl.formatMessage({ id: "quickPrompts.editor.name" })}
            </span>
            <Input
              value={name}
              maxLength={200}
              autoFocus
              data-testid="quick-prompt-save-name"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-ui-caption text-foreground-subtle">
              {intl.formatMessage({ id: "quickPrompts.editor.scope" })}
            </span>
            <div className="flex gap-2">
              {scopeButton("project")}
              {scopeButton("global")}
            </div>
            {explanationId ? (
              <p role="status" className="text-ui-caption text-foreground-subtle">
                {intl.formatMessage({ id: explanationId })}
              </p>
            ) : null}
          </div>
          {error ? (
            <p role="alert" className="text-ui-caption text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                if (!body) return;
                onMoreOptions({
                  mode: "create",
                  scope,
                  initialName: name,
                  initialBody: body,
                });
              }}
            >
              {intl.formatMessage({ id: "quickPrompts.save.moreOptions" })}
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="quick-prompt-save-submit"
              disabled={!canSave}
              onClick={() => void save()}
            >
              {intl.formatMessage({ id: "quickPrompts.save.submit" })}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
