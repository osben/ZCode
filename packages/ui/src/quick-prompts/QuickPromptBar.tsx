/**
 * Quick prompt row above the composer (specs/composer-quick-prompts.md, rules 1-3, 6-9, 17, 21).
 * Chips insert through the editor handle; the send path is delegated to the composer's own submit, passed in as
 * onSendMarkdown, so queue admission and held-queue confirmation stay in one place.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent,
} from "react";
import { PlusIcon } from "lucide-react";
import type {
  IQuickPromptService,
  QuickPrompt,
  QuickPromptProjectRef,
  QuickPromptSnapshot,
} from "./contract.js";
import { Button } from "@/components/ui/button.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card.js";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetDescription,
  BottomSheetHeader,
  BottomSheetTitle,
} from "@/components/mobile-ui/bottom-sheet.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { computeQuickPromptScrollFades, type QuickPromptScrollFades } from "./scrollFades.js";
import { isAppleKeyboardPlatform } from "@/lib/keyboardShortcuts.js";
import { useIsMobileTextInputViewport } from "@/lib/mobileTextInput.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { logger } from "@/logger.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import {
  composeQuickPromptRow,
  defaultQuickPromptScope,
  isQuickPromptBodyPresent,
  isQuickPromptFirstRun,
  quickPromptScopeBlocks,
  resolveQuickPromptChipAction,
} from "@/quick-prompts/model.js";
import {
  QuickPromptEditorDialog,
  type QuickPromptEditorTarget,
} from "@/quick-prompts/QuickPromptEditorDialog.js";
import { QuickPromptSavePopover } from "@/quick-prompts/QuickPromptSavePopover.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/index.js";

const LONG_PRESS_MS = 500;

export interface QuickPromptBarProps {
  snapshot: QuickPromptSnapshot | null;
  project: QuickPromptProjectRef | null;
  service: IQuickPromptService | null;
  refresh: () => Promise<void>;
  inputApiRef: MutableRefObject<LexicalChatInputHandle | null>;
  /** Whether the composer currently holds anything to submit (text, attachments or contexts). Decides ⌘-click send. */
  draftHasContent: boolean;
  /** Runs the composer's own submit with the inserted markdown; used only by the send variant of a chip. */
  onSendMarkdown: (markdown: string) => void;
  workspacePath: string;
  workspaceIdentity?: string;
}

export function QuickPromptBar({
  snapshot,
  project,
  service,
  refresh,
  inputApiRef,
  draftHasContent,
  onSendMarkdown,
  workspacePath,
  workspaceIdentity,
}: QuickPromptBarProps) {
  const { intl } = useZCodeIntl();
  // Only editor text can become a quick prompt (attachments and contexts cannot), so "Save draft" needs text in the
  // editor body. Read at render: the composer re-renders on every text change, which re-renders this bar.
  const draftHasText =
    draftHasContent && isQuickPromptBodyPresent(inputApiRef.current?.getMarkdown() ?? "");
  const isMobile = useIsMobileTextInputViewport();
  const directory = useOptionalProjectDirectory();
  const [editorTarget, setEditorTarget] = useState<QuickPromptEditorTarget | null>(null);
  const [savePopoverOpen, setSavePopoverOpen] = useState(false);
  const [sheetPrompt, setSheetPrompt] = useState<QuickPrompt | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [scrollFades, setScrollFades] = useState<QuickPromptScrollFades>({
    left: false,
    right: false,
  });
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const updateScrollFades = useCallback(() => {
    const element = toolbarRef.current;
    if (!element) return;
    const next = computeQuickPromptScrollFades(element);
    setScrollFades((current) =>
      current.left === next.left && current.right === next.right ? current : next,
    );
  }, []);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressFiredRef = useRef(false);

  const projectName =
    project && directory
      ? directory.projects.find(
          (candidate) => candidate.id === project.projectId && candidate.hostId === project.hostId,
        )?.name
      : undefined;

  const insertPrompt = useCallback(
    (prompt: QuickPrompt, modifierPressed: boolean) => {
      const input = inputApiRef.current;
      if (!input) return;
      const action = resolveQuickPromptChipAction({
        modifierPressed,
        draftEmpty: !draftHasContent,
      });
      try {
        input.insertSerializedBody(prompt.body.nodes);
      } catch (cause) {
        // The body and the name never reach the log; the id identifies the broken row.
        logger.warn("[quick-prompts] insert failed", { promptId: prompt.promptId, cause });
        setActionError(intl.formatMessage({ id: "quickPrompts.errors.insert" }));
        return;
      }
      if (action === "insert-and-send") onSendMarkdown(input.getMarkdown());
    },
    [draftHasContent, inputApiRef, intl, onSendMarkdown],
  );

  const runAction = useCallback(
    async (label: string, operation: () => Promise<unknown>) => {
      setActionError(null);
      try {
        await operation();
        await refresh();
      } catch (cause) {
        logger.warn(`[quick-prompts] ${label} failed`, cause);
        setActionError(intl.formatMessage({ id: "quickPrompts.errors.action" }));
      }
    },
    [intl, refresh],
  );

  const hidePrompt = (prompt: QuickPrompt) => {
    if (!service || !project) return;
    void runAction("hide", () =>
      service.setHidden({ promptId: prompt.promptId, project, hidden: true }),
    );
  };

  const removeFromRow = (prompt: QuickPrompt) => {
    if (!service) return;
    void runAction("remove from row", () =>
      service.setPinned({ promptId: prompt.promptId, pinned: false }),
    );
  };

  const deletePrompt = async (prompt: QuickPrompt) => {
    if (!service) return;
    const confirmed = await useConfirmDialogStore.getState().requestConfirmation({
      title: intl.formatMessage({
        id:
          prompt.scope === "global"
            ? "quickPrompts.confirm.deleteEverywhere.title"
            : "quickPrompts.confirm.delete.title",
      }),
      description: intl.formatMessage({
        id:
          prompt.scope === "global"
            ? "quickPrompts.confirm.deleteEverywhere.description"
            : "quickPrompts.confirm.delete.description",
      }),
      confirmLabel: intl.formatMessage({ id: "quickPrompts.confirm.delete" }),
      confirmVariant: "destructive",
    });
    if (!confirmed) return;
    await runAction("delete", () => service.delete({ promptId: prompt.promptId }));
  };

  const startLongPress = (prompt: QuickPrompt) => (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse") return;
    longPressFiredRef.current = false;
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = window.setTimeout(() => {
      longPressFiredRef.current = true;
      setSheetPrompt(prompt);
    }, LONG_PRESS_MS);
  };

  const cancelLongPress = () => {
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  };

  // Hook must stay above the early return. The row mounts only once service+snapshot exist, and chips
  // derive from the snapshot, so both gate re-measuring; container width changes ride the observer.
  const rowMounted = Boolean(service && snapshot);
  useEffect(() => {
    updateScrollFades();
    const element = toolbarRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateScrollFades);
    observer.observe(element);
    return () => observer.disconnect();
  }, [rowMounted, snapshot, updateScrollFades]);

  // Hidden until a snapshot exists: a blank row while the first read is in flight would flash the first-run hint.
  if (!service || !snapshot) return null;

  const chips = composeQuickPromptRow(snapshot);
  const firstRun = isQuickPromptFirstRun(snapshot);
  const defaultScope = defaultQuickPromptScope(project);
  const createBlocked = quickPromptScopeBlocks({
    scope: defaultScope,
    project,
    bodyNodes: null,
    snapshot,
  }).includes("limit");
  const modifierLabel = isAppleKeyboardPlatform() ? "⌘" : "Ctrl";
  const hintText = intl.formatMessage(
    { id: "quickPrompts.hint.tooltip" },
    { modifier: modifierLabel },
  );

  const chipButton = (prompt: QuickPrompt) => {
    const button = (
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="quick-prompt-chip"
        data-prompt-id={prompt.promptId}
        className={
          isMobile
            ? "min-h-9 max-w-[12rem] shrink-0 truncate rounded-full px-3"
            : "h-7 max-w-[12rem] shrink-0 truncate rounded-full px-2.5"
        }
        onMouseDown={(event) => {
          // Keeps the editor selection: the caret must not move when a chip is clicked.
          event.preventDefault();
        }}
        onPointerDown={isMobile ? startLongPress(prompt) : undefined}
        onPointerUp={isMobile ? cancelLongPress : undefined}
        onPointerLeave={isMobile ? cancelLongPress : undefined}
        onPointerCancel={isMobile ? cancelLongPress : undefined}
        onClick={(event) => {
          if (isMobile) {
            if (longPressFiredRef.current) {
              longPressFiredRef.current = false;
              return;
            }
            insertPrompt(prompt, false);
            return;
          }
          const modifierPressed = isAppleKeyboardPlatform() ? event.metaKey : event.ctrlKey;
          insertPrompt(prompt, modifierPressed);
        }}
      >
        <span className="truncate">{prompt.name}</span>
      </Button>
    );

    if (isMobile) return <span key={prompt.promptId}>{button}</span>;

    const chipMenu = (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {/* HoverCard renders no DOM, so the context menu trigger needs a real element to receive contextmenu. */}
          <span className="contents">
            <HoverCard openDelay={400} closeDelay={100}>
              <HoverCardTrigger asChild>{button}</HoverCardTrigger>
              <HoverCardContent align="start" className="w-80 max-w-[90vw] text-ui-base">
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate font-medium text-foreground">{prompt.name}</span>
                    <span className="shrink-0 text-ui-caption text-foreground-subtle">
                      {intl.formatMessage({
                        id:
                          prompt.scope === "global"
                            ? "quickPrompts.scope.global"
                            : "quickPrompts.scope.project",
                      })}
                    </span>
                  </div>
                  <p className="line-clamp-6 whitespace-pre-wrap break-words text-foreground-subtle">
                    {prompt.body.markdown}
                  </p>
                  <p className="text-ui-caption text-foreground-subtlest">{hintText}</p>
                </div>
              </HoverCardContent>
            </HoverCard>
          </span>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            data-testid="quick-prompt-menu-edit"
            onSelect={() => setEditorTarget({ mode: "edit", prompt })}
          >
            {intl.formatMessage({ id: "quickPrompts.menu.edit" })}
          </ContextMenuItem>
          {prompt.scope === "global" && project ? (
            <ContextMenuItem
              data-testid="quick-prompt-menu-hide"
              onSelect={() => hidePrompt(prompt)}
            >
              {intl.formatMessage({ id: "quickPrompts.menu.hide" })}
            </ContextMenuItem>
          ) : null}
          {prompt.scope === "project" ? (
            <ContextMenuItem
              data-testid="quick-prompt-menu-remove"
              onSelect={() => removeFromRow(prompt)}
            >
              {intl.formatMessage({ id: "quickPrompts.menu.removeFromRow" })}
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem
            data-testid="quick-prompt-menu-delete"
            variant="destructive"
            onSelect={() => void deletePrompt(prompt)}
          >
            {intl.formatMessage({
              id:
                prompt.scope === "global"
                  ? "quickPrompts.menu.deleteEverywhere"
                  : "quickPrompts.menu.delete",
            })}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
    return (
      <span key={prompt.promptId} className="contents">
        {chipMenu}
      </span>
    );
  };

  return (
    <div data-testid="quick-prompt-row" className="relative mb-2 flex min-w-0 items-center gap-2">
      <div
        role="toolbar"
        aria-label={intl.formatMessage({ id: "quickPrompts.row.label" })}
        ref={toolbarRef}
        onScroll={updateScrollFades}
        className="no-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-0.5"
      >
        {chips.map((prompt) => chipButton(prompt))}
        {isMobile ? null : (
          <span className="flex shrink-0 items-center gap-2">
            {draftHasText ? (
              <QuickPromptSavePopover
                open={savePopoverOpen}
                onOpenChange={setSavePopoverOpen}
                service={service}
                project={project}
                snapshot={snapshot}
                inputApiRef={inputApiRef}
                refresh={refresh}
                onMoreOptions={(target) => {
                  setSavePopoverOpen(false);
                  setEditorTarget(target);
                }}
              >
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="quick-prompt-save-draft"
                  className="h-7 shrink-0 rounded-full px-2.5"
                  onMouseDown={(event) => event.preventDefault()}
                >
                  {intl.formatMessage({ id: "quickPrompts.saveDraft" })}
                </Button>
              </QuickPromptSavePopover>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="quick-prompt-add"
                aria-label={intl.formatMessage({ id: "quickPrompts.add" })}
                title={
                  createBlocked
                    ? intl.formatMessage({ id: "quickPrompts.limit.reached" })
                    : undefined
                }
                disabled={createBlocked}
                className={
                  firstRun ? "h-7 shrink-0 rounded-full px-2.5" : "size-7 shrink-0 rounded-full p-0"
                }
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setEditorTarget({ mode: "create", scope: defaultScope })}
              >
                <PlusIcon aria-hidden className="size-3.5" />
                {firstRun ? intl.formatMessage({ id: "quickPrompts.add" }) : null}
              </Button>
            )}
            {firstRun ? (
              <span
                className="min-w-0 truncate text-ui-caption text-foreground-subtle"
                data-testid="quick-prompt-first-run-hint"
              >
                {intl.formatMessage({ id: "quickPrompts.add.hint" })}
              </span>
            ) : null}
          </span>
        )}
      </div>
      {actionError ? (
        <p role="alert" className="absolute -top-5 left-0 text-ui-caption text-destructive">
          {actionError}
        </p>
      ) : null}
      {/* Fades hint at hidden chips; a row that fits shows none. */}
      {scrollFades.left ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-4 bg-gradient-to-r from-surface to-transparent"
        />
      ) : null}
      {scrollFades.right ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-4 bg-gradient-to-l from-surface to-transparent"
        />
      ) : null}
      {editorTarget ? (
        <QuickPromptEditorDialog
          target={editorTarget}
          onClose={() => setEditorTarget(null)}
          project={project}
          projectName={projectName}
          snapshot={snapshot}
          service={service}
          refresh={refresh}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
        />
      ) : null}
      <BottomSheet
        open={sheetPrompt !== null}
        onOpenChange={(open) => !open && setSheetPrompt(null)}
      >
        <BottomSheetContent>
          {sheetPrompt ? (
            <>
              <BottomSheetHeader>
                <BottomSheetTitle>{sheetPrompt.name}</BottomSheetTitle>
                <BottomSheetDescription className="line-clamp-6 whitespace-pre-wrap break-words">
                  {sheetPrompt.body.markdown}
                </BottomSheetDescription>
              </BottomSheetHeader>
              <div className="flex gap-2 p-4">
                <Button
                  type="button"
                  variant="default"
                  data-testid="quick-prompt-send-now"
                  onClick={() => {
                    insertPrompt(sheetPrompt, true);
                    setSheetPrompt(null);
                  }}
                >
                  {intl.formatMessage({ id: "quickPrompts.mobile.sendNow" })}
                </Button>
              </div>
            </>
          ) : null}
        </BottomSheetContent>
      </BottomSheet>
    </div>
  );
}
