import {
  INCOGNITO_CAPABILITY_KEYS,
  resolveIncognitoDefaults,
  type AppSettings,
  type IncognitoCapabilityKey,
} from "@zcode/shared";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * Settings «Incognito» (specs/incognito-session.md): default capability set for new incognito
 * sessions. The fork sidecar replaces `incognitoDefaults` as a whole, so every write sends the full
 * resolved object with one capability flipped.
 */
export function IncognitoSettingsSection({
  settings,
  onUpdate,
}: {
  settings: AppSettings | null | undefined;
  onUpdate: (patch: Partial<AppSettings>) => Promise<void> | void;
}) {
  const { intl } = useZCodeIntl();
  const defaults = resolveIncognitoDefaults(settings?.incognitoDefaults);
  const toggle = (capability: IncognitoCapabilityKey, included: boolean) =>
    onUpdate({ incognitoDefaults: { ...defaults, [capability]: included } });

  return (
    <div className="space-y-4" data-testid="settings-incognito-section">
      <p className="text-ui-base leading-6 text-foreground-subtle">
        {intl.formatMessage({ id: "settings.incognito.description" })}
      </p>
      <SettingsGroupCard>
        {INCOGNITO_CAPABILITY_KEYS.map((capability) => {
          const label = intl.formatMessage({ id: `incognito.capability.${capability}.label` });
          return (
            <SettingsRow
              key={capability}
              label={label}
              description={intl.formatMessage({
                id: `incognito.capability.${capability}.description`,
              })}
              control={
                <Switch
                  aria-label={label}
                  checked={defaults[capability]}
                  data-testid={`settings-incognito-${capability}`}
                  onCheckedChange={(checked) => {
                    void toggle(capability, checked);
                  }}
                />
              }
            />
          );
        })}
      </SettingsGroupCard>
      <p className="text-ui-sm leading-5 text-foreground-subtle">
        {intl.formatMessage({ id: "settings.incognito.scopeHint" })}
      </p>
    </div>
  );
}
