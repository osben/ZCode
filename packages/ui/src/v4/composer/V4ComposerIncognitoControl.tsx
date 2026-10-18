import { memo, useRef } from "react";
import { VenetianMask, XIcon } from "lucide-react";
import {
  INCOGNITO_CAPABILITY_KEYS,
  TID_V4_COMPOSER_INPUT,
  resolveIncognitoDefaults,
} from "@zcode/shared";
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
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
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
 * the chip shows the active state without relying on color.
 */
export const V4ComposerIncognitoControl = memo(function V4ComposerIncognitoControl({
  workspaceKey,
  disabled,
}: {
  workspaceKey: string;
  disabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const services = useOptionalServices();
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  const capabilities = useDraftIncognitoIntentStore((state) =>
    selectDraftIncognito(state, workspaceKey),
  );
  const { activate, deactivate, setCapability } = useDraftIncognitoIntentStore.getState();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const active = capabilities !== null;
  const toggleLabel = intl.formatMessage({ id: "chat.incognito.toggle" });
  const removeLabel = intl.formatMessage({ id: "chat.incognito.removeMarker" });

  return (
    <>
      <DropdownMenu>
        <ControlHintTooltip title={toggleLabel}>
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
              className={cn("h-7 w-7 rounded-lg px-0", active && "text-incognito")}
            >
              <VenetianMask className="size-4" />
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
          <DropdownMenuCheckboxItem
            checked={active}
            onCheckedChange={(checked) => {
              if (checked) {
                // Settings defaults are read at activation; harnesses without services start locked down.
                void (services?.settingService.get() ?? Promise.resolve(undefined))
                  .catch((error: unknown) => {
                    logger.warn("Incognito defaults unavailable; using lockdown", { error });
                    return undefined;
                  })
                  .then((settings) =>
                    activate(workspaceKey, resolveIncognitoDefaults(settings?.incognitoDefaults)),
                  );
              } else {
                deactivate(workspaceKey);
              }
            }}
            onSelect={(event) => event.preventDefault()}
            data-testid={TID_V4_COMPOSER_INCOGNITO_TOGGLE}
            className="min-h-13 items-start gap-3 py-2"
          >
            <VenetianMask className="mt-0.5 size-4.5 shrink-0" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span>{toggleLabel}</span>
              <span className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "chat.incognito.toggleDescription" })}
              </span>
            </span>
          </DropdownMenuCheckboxItem>
          {capabilities ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "chat.incognito.includeHeading" })}
              </DropdownMenuLabel>
              {INCOGNITO_CAPABILITY_KEYS.map((capability) => (
                <DropdownMenuCheckboxItem
                  key={capability}
                  checked={capabilities[capability]}
                  onCheckedChange={(checked) =>
                    setCapability(workspaceKey, capability, checked === true)
                  }
                  onSelect={(event) => event.preventDefault()}
                  data-testid={`${TID_V4_COMPOSER_INCOGNITO_TOGGLE}-${capability}`}
                >
                  {intl.formatMessage({ id: `incognito.capability.${capability}.label` })}
                </DropdownMenuCheckboxItem>
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
        <span data-testid={TID_V4_COMPOSER_INCOGNITO_MARKER} className="flex items-center gap-1">
          <span
            role="separator"
            aria-orientation="vertical"
            className="h-3 w-px shrink-0 bg-border"
          />
          <ControlHintTooltip title={removeLabel}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              data-composer-collapse-priority="2"
              onClick={() => deactivate(workspaceKey)}
              aria-label={removeLabel}
              className="group/incognito h-7 gap-1 rounded-lg px-2 text-ui-base text-incognito hover:text-incognito data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0"
            >
              <VenetianMask className="size-4 group-hover/incognito:hidden group-focus-visible/incognito:hidden" />
              <XIcon className="hidden size-4 group-hover/incognito:block group-focus-visible/incognito:block" />
              <span className="inline group-data-[composer-compact=true]/incognito:hidden">
                {intl.formatMessage({ id: "chat.incognito.marker" })}
              </span>
            </Button>
          </ControlHintTooltip>
        </span>
      ) : null}
    </>
  );
});
