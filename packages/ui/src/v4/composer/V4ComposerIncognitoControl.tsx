import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon, VenetianMask, XIcon } from "lucide-react";
import { INCOGNITO_CAPABILITY_KEYS, TID_V4_COMPOSER_INPUT } from "@zcode/shared";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useIncognitoDefaultsReader } from "@/hooks/useIncognitoDefaultsReader.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { setPendingSettingsSection } from "@/lib/settingsNavigation.js";
import { restoreComposerInputFocusAfterPickerClose } from "@/lib/pickerFocus.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import {
  selectDraftIncognito,
  selectDraftIncognitoGeneration,
  useDraftIncognitoIntentStore,
} from "@/v4/composer/draftIncognitoIntent.js";

export const TID_V4_COMPOSER_INCOGNITO_TRIGGER = "v4-composer-incognito-trigger";
export const TID_V4_COMPOSER_INCOGNITO_TOGGLE = "v4-composer-incognito-toggle";
export const TID_V4_COMPOSER_INCOGNITO_MARKER = "v4-composer-incognito-marker";
export const TID_V4_COMPOSER_INCOGNITO_OFF = "v4-composer-incognito-off";

/**
 * Draft-only incognito toggle (specs/incognito-session.md "Composer toggle"): the menu turns the
 * mode on from the Settings defaults and lets the user opt capabilities back in for this session.
 * While active the control is a chip with the «Incognito» label (not color-only) whose turn-off
 * button is revealed inline on hover/focus, following the project chip in ChatEmptyState.
 */

/** Visible checkbox for a menu row; the row itself stays the menuitemcheckbox. */
function MenuCheckbox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-state={checked ? "checked" : "unchecked"}
      className={cn(
        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border border-input-border bg-input",
        checked && "border-incognito bg-incognito text-primary-foreground",
      )}
    >
      {checked ? <CheckIcon className="size-3" /> : null}
    </span>
  );
}

/** Menu checkbox row with a leading checkbox instead of the trailing check indicator. */
function IncognitoCheckboxRow({
  checked,
  onCheckedChange,
  testId,
  children,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  testId: string;
  children: ReactNode;
}) {
  return (
    <DropdownMenuCheckboxItem
      checked={checked}
      onCheckedChange={(next) => onCheckedChange(next === true)}
      onSelect={(event) => event.preventDefault()}
      data-testid={testId}
      className="items-start gap-2.5 pr-2 [&_[data-slot=dropdown-menu-checkbox-item-indicator]]:hidden"
    >
      <MenuCheckbox checked={checked} />
      {children}
    </DropdownMenuCheckboxItem>
  );
}
export const V4ComposerIncognitoControl = memo(function V4ComposerIncognitoControl({
  workspaceKey,
  disabled,
}: {
  workspaceKey: string;
  disabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const readIncognitoDefaults = useIncognitoDefaultsReader();
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  const capabilities = useDraftIncognitoIntentStore((state) =>
    selectDraftIncognito(state, workspaceKey),
  );
  const { activateIfCurrent, deactivate, setCapability } = useDraftIncognitoIntentStore.getState();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const active = capabilities !== null;
  const toggleLabel = intl.formatMessage({ id: "chat.incognito.toggle" });
  const removeLabel = intl.formatMessage({ id: "chat.incognito.turnOff" });

  const showOffButton = active && !disabled;

  return (
    <div
      data-testid={active ? TID_V4_COMPOSER_INCOGNITO_MARKER : undefined}
      // Compact mode (specs/incognito-session.md "Composer toggle") collapses this wrapper, which hides the label and the turn-off overlay.
      data-composer-collapse-priority="1"
      className={cn(
        "group/incognito-chip relative flex shrink-0 items-center rounded-full",
        active && "bg-incognito/10 hover:bg-incognito/15 focus-within:bg-incognito/15",
      )}
    >
      {active ? (
        <ControlHintTooltip title={removeLabel}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            onClick={() => deactivate(workspaceKey)}
            aria-label={removeLabel}
            data-testid={TID_V4_COMPOSER_INCOGNITO_OFF}
            className="pointer-events-none absolute left-1 top-1/2 z-10 -translate-y-1/2 rounded-full text-foreground-subtle opacity-0 transition-opacity group-hover/incognito-chip:pointer-events-auto group-hover/incognito-chip:opacity-100 group-focus-within/incognito-chip:pointer-events-auto group-focus-within/incognito-chip:opacity-100 group-data-[composer-compact=true]/incognito-chip:hidden"
          >
            <XIcon className="size-3.5" />
          </Button>
        </ControlHintTooltip>
      ) : null}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        {/* The hint must stay closed while the menu is open, or its layer dismisses the menu. */}
        <ControlHintTooltip title={toggleLabel} open={menuOpen ? false : undefined}>
          <DropdownMenuTrigger asChild>
            <Button
              ref={triggerRef}
              variant="ghost"
              size="sm"
              disabled={disabled}
              aria-label={toggleLabel}
              aria-pressed={active}
              data-testid={TID_V4_COMPOSER_INCOGNITO_TRIGGER}
              className={cn(
                "h-7",
                active
                  ? "gap-1 rounded-full bg-transparent px-2 text-ui-base text-incognito hover:bg-transparent hover:text-incognito group-data-[composer-compact=true]/incognito-chip:w-7 group-data-[composer-compact=true]/incognito-chip:px-0"
                  : "w-7 rounded-lg px-0",
              )}
            >
              <VenetianMask
                className={cn(
                  "size-4",
                  showOffButton &&
                    "transition-opacity group-hover/incognito-chip:opacity-0 group-focus-within/incognito-chip:opacity-0 group-data-[composer-compact=true]/incognito-chip:!opacity-100",
                )}
              />
              {active ? (
                <span className="inline group-data-[composer-compact=true]/incognito-chip:hidden">
                  {intl.formatMessage({ id: "chat.incognito.marker" })}
                </span>
              ) : null}
            </Button>
          </DropdownMenuTrigger>
        </ControlHintTooltip>
        <DropdownMenuContent
          side="top"
          sideOffset={4}
          className="w-72"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreComposerInputFocusAfterPickerClose({
              anchor: triggerRef.current,
              fallbackSelector: `[data-testid="${TID_V4_COMPOSER_INPUT}"]`,
            });
          }}
        >
          <IncognitoCheckboxRow
            checked={active}
            testId={TID_V4_COMPOSER_INCOGNITO_TOGGLE}
            onCheckedChange={(checked) => {
              if (checked) {
                // The defaults read is async; freeze the intent generation so a send, uncheck or
                // unmount that happens before it resolves discards this activation instead of
                // arming a stale draft.
                const generation = selectDraftIncognitoGeneration(
                  useDraftIncognitoIntentStore.getState(),
                  workspaceKey,
                );
                void readIncognitoDefaults().then((defaults) => {
                  if (mountedRef.current) {
                    activateIfCurrent(workspaceKey, defaults, generation);
                  }
                });
              } else {
                deactivate(workspaceKey);
              }
            }}
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span>{toggleLabel}</span>
              <span className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "chat.incognito.toggleDescription" })}
              </span>
            </span>
          </IncognitoCheckboxRow>
          {capabilities ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "chat.incognito.includeHeading" })}
              </DropdownMenuLabel>
              {INCOGNITO_CAPABILITY_KEYS.map((capability) => (
                <IncognitoCheckboxRow
                  key={capability}
                  checked={capabilities[capability]}
                  testId={`${TID_V4_COMPOSER_INCOGNITO_TOGGLE}-${capability}`}
                  onCheckedChange={(checked) => setCapability(workspaceKey, capability, checked)}
                >
                  {intl.formatMessage({ id: `incognito.capability.${capability}.label` })}
                </IncognitoCheckboxRow>
              ))}
            </>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              setPendingSettingsSection("incognito");
              openSettingsTab();
            }}
          >
            {intl.formatMessage({ id: "chat.incognito.settingsLink" })}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
});
