/**
 * Persistent CUA entry button in the composer.
 *
 * Presentational only: all state decisions live in useCuaComposerEntry / cuaComposerEntryState; this component only handles
 * “do not render when invisible” and maps the view to DOM. Its visual weight intentionally matches other toolbar controls to avoid suggesting that CUA is available when it is not.
 */
import { memo } from "react";
import { MonitorCogIcon } from "lucide-react";
import { TID_V4_COMPOSER_CUA_ENTRY } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  supportsLocalMacCuaPermissionOnboarding,
  supportsLocalWindowsCuaEntry,
} from "@/lib/cuaPlatform.js";
import {
  useCuaComposerEntry,
  type UseCuaComposerEntryParams,
} from "@/hooks/useCuaComposerEntry.js";

export type V4ComposerCuaEntryProps = UseCuaComposerEntryParams;

/**
 * Platform-gate wrapper: do not mount the inner component when the platform is unsupported (or when the host does not provide platform / services context).
 *
 * There are two reasons for keeping two layers:
 * 1. Semantics — “invisible means no background work.” If the platform gate fails, do not subscribe to settings, read the plugin store,
 *    or start permission polling; this is more complete than checking inside and returning null afterward.
 * 2. Robustness — the composer renders in hosts without PlatformProvider / ServiceProvider (including existing component
 *    tests). The inner layer's usePlatform / useServices hooks throw if a provider is missing, crashing the entire
 *    composer. Use optional variants here; if context is missing, quietly render nothing.
 */
function V4ComposerCuaEntryImpl(props: V4ComposerCuaEntryProps) {
  const platform = useOptionalPlatform();
  const services = useOptionalServices();
  const platformSupported =
    platform !== null &&
    services !== null &&
    (supportsLocalMacCuaPermissionOnboarding(platform) || supportsLocalWindowsCuaEntry(platform));
  if (!platformSupported) return null;
  return <V4ComposerCuaEntryMounted {...props} />;
}

function V4ComposerCuaEntryMounted(props: V4ComposerCuaEntryProps) {
  const { intl } = useZCodeIntl();
  const { view, onActivate } = useCuaComposerEntry(props);
  const label = intl.formatMessage({ id: "chat.toolbar.computerUse.label" });

  // The remaining three visibility gates (hidden in settings / macOS service missing / computer control disabled) → render no DOM.
  if (!view.visible) return null;
  const tooltip = intl.formatMessage({ id: view.tooltipMessageId });

  return (
    <ControlHintTooltip title={tooltip}>
      <Button
        type="button"
        variant="ghost"
        size="default"
        data-testid={TID_V4_COMPOSER_CUA_ENTRY}
        data-composer-collapse-priority="0"
        // e2e / debugging anchor: expose UI state and disable reason so tests do not have to infer them from color class names.
        data-cua-state={view.uiState}
        data-cua-interaction-disabled={view.interactionDisabled ? "true" : "false"}
        aria-label={label}
        // aria-disabled represents only “temporarily unavailable” (session-busy), the only case with no click action.
        // Other states (ready / error / enabling) are status indicators, not disabled buttons; marking them disabled would make screen
        // readers announce a normally ready entry point as unavailable. Use aria-disabled + a click guard instead of native disabled,
        // because native disabled does not trigger hover in most browsers, hiding the “session in progress” explanation.
        aria-disabled={view.interactionDisabled || undefined}
        onClick={view.clickAction === "open-settings" ? onActivate : undefined}
        className={
          "group/cua h-7 w-fit justify-center gap-1 rounded-lg px-1.5 py-1.5 text-ui-base data-[composer-compact=true]:size-7 data-[composer-compact=true]:gap-0 data-[composer-compact=true]:p-0 " +
          (view.interactionDisabled ? "opacity-50" : "")
        }
      >
        <MonitorCogIcon className="size-4 shrink-0" aria-hidden />
        <span
          className="inline-flex whitespace-nowrap group-data-[composer-compact=true]/cua:hidden"
          data-cua-label
        >
          {label}
        </span>
        {/* M7: The status dot was removed by product decision. This entry does not display status;
          status is shown in Settings, which starts the Helper on demand and reads its actual state. */}
      </Button>
    </ControlHintTooltip>
  );
}

export const V4ComposerCuaEntry = memo(V4ComposerCuaEntryImpl);
