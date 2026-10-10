import type { ReactNode } from "react";
import { Keyboard, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatShortcutBindingLabel } from "@/shortcuts/label.js";
import type { ShortcutKeySearch } from "./useShortcutKeySearch.js";

interface ShortcutSearchBarProps {
  query: string;
  onQueryChange: (value: string) => void;
  keySearch: ShortcutKeySearch;
  /** Armed key search is mutually exclusive with inline recording: cancel any active inline recording first. */
  onArmKeySearch: () => void;
  /** Action area to the right of the search bar ("Restore all defaults" button). */
  actions?: ReactNode;
}

/** Shortcut-settings search bar: text search input + VS Code-style "Search by key combination" button. */
export function ShortcutSearchBar({
  query,
  onQueryChange,
  keySearch,
  onArmKeySearch,
  actions,
}: ShortcutSearchBarProps) {
  const { intl } = useZCodeIntl();
  // VS Code-style display: show the captured key combination as input text on the left (in place of the text search term;
  // text filtering remains active internally, and clearing with × returns to text-only search).
  const keyLabel =
    keySearch.binding !== null ? formatShortcutBindingLabel(keySearch.binding) : null;

  return (
    <div className="flex gap-2">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle" />
        <Input
          className={`pl-9 font-mono ${keyLabel !== null ? "pr-16 text-brand" : "pr-9"}`}
          placeholder={
            keySearch.armed
              ? intl.formatMessage({ id: "settings.shortcuts.keySearchPlaceholder" })
              : intl.formatMessage({ id: "settings.shortcuts.searchPlaceholder" })
          }
          value={keyLabel ?? query}
          onChange={(e) => onQueryChange(e.target.value)}
          // While armed, keyboard events are exclusively handled by window capture; after capture, the displayed value is a shortcut label rather than editable text.
          // Both fields are read-only to avoid visual ambiguity from a lingering IME or focus state.
          readOnly={keySearch.armed || keyLabel !== null}
          data-testid="settings-shortcut-search-input"
        />
        {keyLabel !== null ? (
          <button
            type="button"
            aria-label={intl.formatMessage({ id: "settings.shortcuts.keySearchClearAria" })}
            data-testid="settings-shortcut-key-search-clear"
            className="absolute right-9 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-foreground-subtle hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
            onClick={keySearch.clear}
          >
            <X className="size-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label={intl.formatMessage({ id: "settings.shortcuts.keySearchAria" })}
          aria-pressed={keySearch.armed}
          data-testid="settings-shortcut-key-search"
          className={`absolute right-2.5 top-1/2 -translate-y-1/2 rounded-sm p-1 focus-visible:outline-2 focus-visible:outline-offset-2 ${
            keySearch.armed ? "text-brand" : "text-foreground-subtle hover:text-foreground"
          }`}
          onClick={() => {
            if (!keySearch.armed) {
              onArmKeySearch();
            }
            keySearch.toggle();
          }}
        >
          <Keyboard className="size-4" />
        </button>
      </div>
      {actions}
    </div>
  );
}
