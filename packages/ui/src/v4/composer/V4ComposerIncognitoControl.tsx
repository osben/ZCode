import { memo, useRef, useState, type ReactNode } from "react";
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
  useDraftIncognitoIntentStore,
} from "@/v4/composer/draftIncognitoIntent.js";

export const TID_V4_COMPOSER_INCOGNITO_TRIGGER = "v4-composer-incognito-trigger";
export const TID_V4_COMPOSER_INCOGNITO_TOGGLE = "v4-composer-incognito-toggle";
export const TID_V4_COMPOSER_INCOGNITO_MARKER = "v4-composer-incognito-marker";

/**
 * Draft-only incognito toggle (specs/incognito-session.md "Composer toggle"): the menu turns the
 * mode on from the Settings defaults and lets the user opt capabilities back in for this session;
 * while active the trigger carries the «Incognito» label (not color-only) next to a turn-off button.
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
  const { activate, deactivate, setCapability } = useDraftIncognitoIntentStore.getState();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const active = capabilities !== null;
  const toggleLabel = intl.formatMessage({ id: "chat.incognito.toggle" });
  const removeLabel = intl.formatMessage({ id: "chat.incognito.removeMarker" });

  return (
    <>
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
              data-composer-collapse-priority="1"
              className={cn(
                "group/incognito h-7 rounded-lg",
                active
                  ? "gap-1 px-2 text-ui-base text-incognito hover:text-incognito data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0"
                  : "w-7 px-0",
              )}
            >
              <VenetianMask className="size-4" />
              {active ? (
                <span className="inline group-data-[composer-compact=true]/incognito:hidden">
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
                void readIncognitoDefaults().then((defaults) => activate(workspaceKey, defaults));
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
      {active ? (
        <span data-testid={TID_V4_COMPOSER_INCOGNITO_MARKER} className="flex items-center">
          <ControlHintTooltip title={removeLabel}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              data-composer-collapse-priority="2"
              onClick={() => deactivate(workspaceKey)}
              aria-label={removeLabel}
              className="h-7 w-7 rounded-lg px-0 text-foreground-subtle"
            >
              <XIcon className="size-4" />
            </Button>
          </ControlHintTooltip>
        </span>
      ) : null}
    </>
  );
});
