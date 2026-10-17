import type { RefObject } from "react";
import { ChevronDown, Folder, Search, SlidersHorizontal, Star, X } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Kbd } from "@/components/ui/kbd.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getPathLeaf } from "@/lib/path.js";
import type { SessionManagerScope } from "./sessionManagerTypes.js";
import { sessionManagerColumnLabelId } from "./sessionManagerColumns.js";
import {
  SESSION_MANAGER_TOGGLEABLE_COLUMNS,
  type SessionManagerToggleableColumn,
  type SessionManagerViewState,
} from "./sessionManagerTypes.js";

interface SessionManagerToolbarProps {
  scope: SessionManagerScope | undefined;
  onClearScope: () => void;
  search: string;
  onSearchChange: (value: string) => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
  viewState: SessionManagerViewState;
  onViewStateChange: (patch: Partial<SessionManagerViewState>) => void;
  onResetFilters: () => void;
  hasActiveFilters: boolean;
  visibleCount: number;
  runningCount: number;
}

function FilterDropdown({
  label,
  options,
  value,
  onSelect,
}: {
  label: string;
  options: ReadonlyArray<{ value: string; labelId: string }>;
  value: string;
  onSelect: (value: string) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="gap-1">
          {label}
          <ChevronDown className="size-3 text-foreground-subtlest" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            className={cn(option.value === value && "bg-selected")}
            onSelect={() => onSelect(option.value)}
          >
            {intl.formatMessage({ id: option.labelId })}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SessionManagerToolbar(props: SessionManagerToolbarProps) {
  const { intl } = useZCodeIntl();
  const visibleColumnSet = new Set<SessionManagerToggleableColumn>(props.viewState.columns);

  const toggleColumn = (column: SessionManagerToggleableColumn, visible: boolean) => {
    const next = new Set(visibleColumnSet);
    if (visible) {
      next.add(column);
    } else {
      next.delete(column);
    }
    // Re-derive from the canonical order so display order can never drift from the layout contract.
    props.onViewStateChange({
      columns: SESSION_MANAGER_TOGGLEABLE_COLUMNS.filter((candidate) => next.has(candidate)),
    });
  };

  return (
    <div className="shrink-0 border-b border-border bg-header">
      {/* The section title and back control belong to the Settings shell; this row keeps only the
          scope chip, search, and columns menu. */}
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        {props.scope ? (
          <span className="inline-flex h-6 items-center gap-1.5 rounded-md bg-accent px-2 text-ui-sm font-medium text-accent-foreground">
            <Folder className="size-3" />
            <span className="max-w-52 truncate">
              {getPathLeaf(props.scope.workspacePath) || props.scope.workspacePath}
            </span>
            <button
              type="button"
              className="inline-flex size-4 items-center justify-center rounded-sm hover:bg-hover"
              aria-label={intl.formatMessage({ id: "sessionManager.clearScope" })}
              onClick={props.onClearScope}
            >
              <X className="size-3" />
            </button>
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <div className="flex h-7 w-56 items-center gap-1.5 rounded-md border border-input-border bg-input px-2">
            <Search className="size-3.5 shrink-0 text-foreground-subtlest" />
            <input
              ref={props.searchInputRef}
              value={props.search}
              onChange={(event) => props.onSearchChange(event.currentTarget.value)}
              placeholder={intl.formatMessage({ id: "sessionManager.search.placeholder" })}
              aria-label={intl.formatMessage({ id: "sessionManager.search.placeholder" })}
              className="min-w-0 flex-1 bg-transparent text-ui-base text-foreground outline-none placeholder:text-foreground-subtlest"
            />
            <Kbd>/</Kbd>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="gap-1">
                <SlidersHorizontal className="size-3" />
                {intl.formatMessage({ id: "sessionManager.columns" })}
                <ChevronDown className="size-3 text-foreground-subtlest" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {SESSION_MANAGER_TOGGLEABLE_COLUMNS.map((column) => (
                <DropdownMenuCheckboxItem
                  key={column}
                  checked={visibleColumnSet.has(column)}
                  onCheckedChange={(checked) => toggleColumn(column, checked === true)}
                  onSelect={(event) => event.preventDefault()}
                >
                  {intl.formatMessage({ id: sessionManagerColumnLabelId(column) })}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="flex min-h-11 flex-wrap items-center gap-2 px-3 py-1.5">
        <FilterDropdown
          label={intl.formatMessage(
            { id: "sessionManager.filter.statusWithValue" },
            {
              value: intl.formatMessage({
                id: `sessionManager.statusFilter.${props.viewState.status}`,
              }),
            },
          )}
          value={props.viewState.status}
          options={[
            { value: "active", labelId: "sessionManager.statusFilter.active" },
            { value: "archived", labelId: "sessionManager.statusFilter.archived" },
            { value: "all", labelId: "sessionManager.statusFilter.all" },
          ]}
          onSelect={(value) =>
            props.onViewStateChange({ status: value as SessionManagerViewState["status"] })
          }
        />
        <FilterDropdown
          label={intl.formatMessage(
            { id: "sessionManager.filter.environmentWithValue" },
            {
              value: intl.formatMessage({
                id: `sessionManager.environmentFilter.${props.viewState.environment}`,
              }),
            },
          )}
          value={props.viewState.environment}
          options={[
            { value: "all", labelId: "sessionManager.environmentFilter.all" },
            { value: "local", labelId: "sessionManager.environmentFilter.local" },
            { value: "worktree", labelId: "sessionManager.environmentFilter.worktree" },
          ]}
          onSelect={(value) =>
            props.onViewStateChange({
              environment: value as SessionManagerViewState["environment"],
            })
          }
        />
        <FilterDropdown
          label={intl.formatMessage(
            { id: "sessionManager.filter.typeWithValue" },
            {
              value: intl.formatMessage({
                id: `sessionManager.typeFilter.${props.viewState.type}`,
              }),
            },
          )}
          value={props.viewState.type}
          options={[
            { value: "all", labelId: "sessionManager.typeFilter.all" },
            { value: "session", labelId: "sessionManager.typeFilter.session" },
            { value: "cron", labelId: "sessionManager.typeFilter.cron" },
            { value: "offpeak", labelId: "sessionManager.typeFilter.offpeak" },
          ]}
          onSelect={(value) =>
            props.onViewStateChange({ type: value as SessionManagerViewState["type"] })
          }
        />
        <Button
          type="button"
          variant={props.viewState.pinnedOnly ? "secondary" : "outline"}
          size="sm"
          aria-pressed={props.viewState.pinnedOnly}
          className="gap-1"
          onClick={() => props.onViewStateChange({ pinnedOnly: !props.viewState.pinnedOnly })}
        >
          <Star className="size-3" />
          {intl.formatMessage({ id: "sessionManager.filter.pinned" })}
        </Button>
        {props.hasActiveFilters ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-accent-foreground"
            onClick={props.onResetFilters}
          >
            {intl.formatMessage({ id: "sessionManager.resetFilters" })}
          </Button>
        ) : null}
        <span className="ml-auto text-ui-sm text-foreground-subtle">
          {intl.formatPlural({ id: "sessionManager.count.sessions" }, props.visibleCount)}
          {" · "}
          {intl.formatPlural({ id: "sessionManager.count.running" }, props.runningCount)}
        </span>
      </div>
    </div>
  );
}
