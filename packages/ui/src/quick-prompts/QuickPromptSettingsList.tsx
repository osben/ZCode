/**
 * One Settings list of quick prompts (spec rule 20): a header with "+ New quick prompt", then rows with a drag
 * handle, the Pinned switch, the Shown-in-project switch (global rows, only when a project is selected) and the
 * "..." menu. Read-only mode (web remote control) renders the same rows with every control disabled.
 */
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { EllipsisIcon, GripVerticalIcon, PlusIcon } from "lucide-react";
import type { QuickPrompt, QuickPromptProjectRef, QuickPromptScope } from "./contract.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { quickPromptPreviewText } from "@/quick-prompts/model.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";

export type QuickPromptListItem = QuickPrompt & { hiddenInProject?: boolean };

export interface QuickPromptSettingsListProps {
  scope: QuickPromptScope;
  title: string;
  hint?: string;
  emptyMessage: string;
  items: readonly QuickPromptListItem[];
  /** The project the Shown-in switch refers to; null hides the switch. */
  shownInProject: { ref: QuickPromptProjectRef; name: string } | null;
  readOnly: boolean;
  createDisabled: boolean;
  /** Localized explanation shown under the header when creating is disabled. */
  createBlockedMessage: string | null;
  duplicateDisabled: boolean;
  onCreate: () => void;
  onEdit: (prompt: QuickPrompt) => void;
  onSetPinned: (prompt: QuickPrompt, pinned: boolean) => void;
  onSetHidden: (prompt: QuickPrompt, hidden: boolean) => void;
  onDuplicate: (prompt: QuickPrompt) => void;
  onDelete: (prompt: QuickPrompt) => void;
  onReorder: (orderedIds: string[]) => void;
}

export function QuickPromptSettingsList(props: QuickPromptSettingsListProps) {
  const { intl } = useZCodeIntl();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const sortable = !props.readOnly && props.items.length > 1;
  const ids = props.items.map((item) => item.promptId);

  const handleDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return;
    const from = ids.indexOf(String(event.active.id));
    const to = ids.indexOf(String(event.over.id));
    if (from < 0 || to < 0) return;
    const next = [...ids];
    const [moved] = next.splice(from, 1);
    if (moved !== undefined) next.splice(to, 0, moved);
    props.onReorder(next);
  };

  const rows = props.items.map((item) => (
    <QuickPromptSettingsRow
      key={item.promptId}
      prompt={item}
      scope={props.scope}
      hiddenInProject={item.hiddenInProject ?? false}
      shownInProject={props.shownInProject}
      readOnly={props.readOnly}
      sortable={sortable}
      duplicateDisabled={props.duplicateDisabled}
      onEdit={props.onEdit}
      onSetPinned={props.onSetPinned}
      onSetHidden={props.onSetHidden}
      onDuplicate={props.onDuplicate}
      onDelete={props.onDelete}
    />
  ));

  return (
    <div data-testid="quick-prompts-settings-list" data-scope={props.scope}>
      <SettingsGroupCard>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <div className="text-ui-base font-medium text-foreground">{props.title}</div>
            {props.hint ? (
              <div className="text-ui-caption text-foreground-subtle">{props.hint}</div>
            ) : null}
          </div>
          {props.readOnly ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="quick-prompts-settings-new"
              data-scope={props.scope}
              disabled={props.createDisabled}
              onClick={props.onCreate}
            >
              <PlusIcon aria-hidden="true" />
              {intl.formatMessage({ id: "quickPrompts.settings.new" })}
            </Button>
          )}
        </div>
        {props.createBlockedMessage && !props.readOnly ? (
          <p role="status" className="px-4 pb-3 text-ui-caption text-foreground-subtle">
            {props.createBlockedMessage}
          </p>
        ) : null}
        {props.items.length === 0 ? (
          <p className="border-t border-border px-4 py-3 text-ui-base text-foreground-subtle">
            {props.emptyMessage}
          </p>
        ) : sortable ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              {rows}
            </SortableContext>
          </DndContext>
        ) : (
          rows
        )}
      </SettingsGroupCard>
    </div>
  );
}

function QuickPromptSettingsRow({
  prompt,
  scope,
  hiddenInProject,
  shownInProject,
  readOnly,
  sortable,
  duplicateDisabled,
  onEdit,
  onSetPinned,
  onSetHidden,
  onDuplicate,
  onDelete,
}: {
  prompt: QuickPromptListItem;
  scope: QuickPromptScope;
  hiddenInProject: boolean;
  shownInProject: { ref: QuickPromptProjectRef; name: string } | null;
  readOnly: boolean;
  sortable: boolean;
  duplicateDisabled: boolean;
  onEdit: (prompt: QuickPrompt) => void;
  onSetPinned: (prompt: QuickPrompt, pinned: boolean) => void;
  onSetHidden: (prompt: QuickPrompt, hidden: boolean) => void;
  onDuplicate: (prompt: QuickPrompt) => void;
  onDelete: (prompt: QuickPrompt) => void;
}) {
  const { intl } = useZCodeIntl();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: prompt.promptId, disabled: !sortable });
  const preview = quickPromptPreviewText(prompt.body.markdown);
  const showShownIn = scope === "global" && shownInProject !== null;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-4 py-3 first:border-t-0 ${
        isDragging ? "relative z-10 bg-card shadow-md" : ""
      }`}
      data-testid="quick-prompts-settings-row"
      data-prompt-id={prompt.promptId}
      data-prompt-name={prompt.name}
    >
      {sortable ? (
        <button
          type="button"
          ref={setActivatorNodeRef}
          data-testid="quick-prompts-settings-drag"
          aria-label={intl.formatMessage({ id: "quickPrompts.settings.reorder" })}
          title={intl.formatMessage({ id: "quickPrompts.settings.reorder" })}
          className="flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-foreground-subtlest hover:bg-surface-hover hover:text-foreground active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVerticalIcon aria-hidden="true" className="size-4" />
        </button>
      ) : null}
      <div className="min-w-0 flex-1 basis-48">
        <div className="truncate text-ui-base font-medium text-foreground">{prompt.name}</div>
        {preview ? (
          <div className="truncate text-ui-base text-foreground-subtle">{preview}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-ui-caption text-foreground-subtle">
          <Switch
            data-testid="quick-prompts-settings-pinned"
            checked={prompt.pinned}
            disabled={readOnly}
            onCheckedChange={(checked) => onSetPinned(prompt, checked)}
          />
          <span>{intl.formatMessage({ id: "quickPrompts.settings.pinned" })}</span>
        </label>
        {showShownIn ? (
          <label className="flex items-center gap-2 text-ui-caption text-foreground-subtle">
            <Switch
              data-testid="quick-prompts-settings-shown"
              checked={!hiddenInProject}
              disabled={readOnly}
              onCheckedChange={(checked) => onSetHidden(prompt, !checked)}
            />
            <span>
              {intl.formatMessage(
                { id: "quickPrompts.settings.shownIn" },
                { project: shownInProject.name },
              )}
            </span>
          </label>
        ) : null}
        {readOnly ? null : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                data-testid="quick-prompts-settings-menu"
                aria-label={intl.formatMessage({ id: "quickPrompts.settings.more" })}
              >
                <EllipsisIcon aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              <DropdownMenuItem
                data-testid="quick-prompts-settings-menu-edit"
                onSelect={() => onEdit(prompt)}
              >
                {intl.formatMessage({ id: "quickPrompts.menu.edit" })}
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid="quick-prompts-settings-menu-duplicate"
                disabled={duplicateDisabled}
                onSelect={() => onDuplicate(prompt)}
              >
                {intl.formatMessage({ id: "quickPrompts.editor.duplicate" })}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                data-testid="quick-prompts-settings-menu-delete"
                onSelect={() => onDelete(prompt)}
              >
                {intl.formatMessage({
                  id:
                    scope === "global"
                      ? "quickPrompts.menu.deleteEverywhere"
                      : "quickPrompts.menu.delete",
                })}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}
