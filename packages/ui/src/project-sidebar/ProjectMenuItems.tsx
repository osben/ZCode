import { Fragment } from "react";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu.js";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu.js";
import type { ProjectRowAction } from "@/project-sidebar/contract.js";

/** Renders project row actions, inserting a separator wherever consecutive `group` values differ. */
export function ProjectMenuItems({
  actions,
  context = false,
}: {
  actions: ProjectRowAction[];
  context?: boolean;
}) {
  const Item = context ? ContextMenuItem : DropdownMenuItem;
  const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator;
  return actions.map((action, index) => {
    const previous = actions[index - 1];
    const startsGroup = previous !== undefined && previous.group !== action.group;
    return (
      <Fragment key={action.id}>
        {startsGroup ? <Separator /> : null}
        <Item
          disabled={action.disabled}
          data-testid={`virtual-project-${context && (action.id.startsWith("files-") || action.id === "create-task") ? "context-" : ""}${action.id}`}
          className={action.destructive ? "text-destructive" : undefined}
          onSelect={action.run}
        >
          {action.icon ? <action.icon className="size-4 shrink-0" aria-hidden="true" /> : null}
          {action.label}
        </Item>
      </Fragment>
    );
  });
}
