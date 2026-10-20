import { TID_MODEL_PROVIDER_GET_API_KEY_BUTTON } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function PresetProviderApiKeyBanner({ onOpenApiKey }: { onOpenApiKey: () => void }) {
  const { intl } = useZCodeIntl();

  // The retrieval entry point does not distinguish personal/team; two buttons and a dedicated field would diverge from the expected single-console entry.
  return (
    <div className="text-foreground-subtlest flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-ui-base">
      <button
        data-testid={TID_MODEL_PROVIDER_GET_API_KEY_BUTTON}
        type="button"
        className="text-primary cursor-pointer rounded-sm font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        onClick={onOpenApiKey}
      >
        {intl.formatMessage({ id: "settings.modelProvider.getApiKey" })}
      </button>
    </div>
  );
}
