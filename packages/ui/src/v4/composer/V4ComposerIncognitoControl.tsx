import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon, VenetianMask, XIcon } from "lucide-react";
import { INCOGNITO_CAPABILITY_KEYS, TID_V4_COMPOSER_INPUT } from "@zcode/shared";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useIncognitoDefaultsReader } from "@/hooks/useIncognitoDefaultsReader.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { restoreComposerInputFocusAfterPickerClose } from "@/lib/pickerFocus.js";
import {
  selectDraftIncognito,
  selectDraftIncognitoGeneration,
  useDraftIncognitoIntentStore,
} from "@/v4/composer/draftIncognitoIntent.js";

export const TID_V4_COMPOSER_INCOGNITO_TRIGGER = "v4-composer-incognito-trigger";
export const TID_V4_COMPOSER_INCOGNITO_MARKER = "v4-composer-incognito-marker";
export const TID_V4_COMPOSER_INCOGNITO_OFF = "v4-composer-incognito-off";
export const TID_V4_COMPOSER_INCOGNITO_CAPABILITY = "v4-composer-incognito-capability";

/**
 * Draft-only incognito control (specs/incognito-session.md "Composer toggle"). Off: the icon turns the
 * mode on directly, with the per-session capability set read from the Settings defaults. On: the chip
 * text opens the capability checklist and the inline × turns the mode off. It lives in the composer top
 * row after the project and branch chips, so it is not a bottom toolbar collapse participant.
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

  // The defaults read is async; freeze the intent generation so a send, turn-off or unmount that
  // happens before it resolves discards this activation instead of arming a stale draft.
  const activate = () => {
    const generation = selectDraftIncognitoGeneration(
      useDraftIncognitoIntentStore.getState(),
      workspaceKey,
    );
    void readIncognitoDefaults().then((defaults) => {
      if (mountedRef.current) {
        activateIfCurrent(workspaceKey, defaults, generation);
      }
    });
  };

  return (
    <div
      data-testid={active ? TID_V4_COMPOSER_INCOGNITO_MARKER : undefined}
      className={cn(
        "group/incognito-chip relative ml-auto flex shrink-0 items-center rounded-full",
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
            className="pointer-events-none absolute left-1 top-1/2 z-10 -translate-y-1/2 rounded-full text-foreground-subtle opacity-0 transition-opacity group-hover/incognito-chip:pointer-events-auto group-hover/incognito-chip:opacity-100 group-focus-within/incognito-chip:pointer-events-auto group-focus-within/incognito-chip:opacity-100"
          >
            <XIcon className="size-3.5" />
          </Button>
        </ControlHintTooltip>
      ) : null}
      {active ? (
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
                aria-pressed={true}
                data-testid={TID_V4_COMPOSER_INCOGNITO_TRIGGER}
                className="h-7 gap-1 rounded-full bg-transparent px-2 text-ui-base text-incognito hover:bg-transparent hover:text-incognito"
              >
                <VenetianMask
                  className={cn(
                    "size-4",
                    showOffButton &&
                      "transition-opacity group-hover/incognito-chip:opacity-0 group-focus-within/incognito-chip:opacity-0",
                  )}
                />
                <span className="inline">
                  {intl.formatMessage({ id: "chat.incognito.marker" })}
                </span>
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
            <DropdownMenuLabel className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "chat.incognito.includeHeading" })}
            </DropdownMenuLabel>
            {INCOGNITO_CAPABILITY_KEYS.map((capability) => (
              <IncognitoCheckboxRow
                key={capability}
                checked={capabilities[capability]}
                testId={`${TID_V4_COMPOSER_INCOGNITO_CAPABILITY}-${capability}`}
                onCheckedChange={(checked) => setCapability(workspaceKey, capability, checked)}
              >
                {intl.formatMessage({ id: `incognito.capability.${capability}.label` })}
              </IncognitoCheckboxRow>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <ControlHintTooltip title={toggleLabel}>
          <Button
            ref={triggerRef}
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label={toggleLabel}
            aria-pressed={false}
            data-testid={TID_V4_COMPOSER_INCOGNITO_TRIGGER}
            onClick={activate}
            className="h-7 w-7 rounded-lg px-0"
          >
            <VenetianMask className="size-4" />
          </Button>
        </ControlHintTooltip>
      )}
    </div>
  );
});
