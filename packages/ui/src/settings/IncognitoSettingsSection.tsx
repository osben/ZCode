import {
  INCOGNITO_CAPABILITY_KEYS,
  resolveIncognitoDefaults,
  type AppSettings,
  type IncognitoCapabilities,
  type IncognitoCapabilityKey,
} from "@zcode/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * Settings «Incognito» (specs/incognito-session.md): default capability set for new incognito
 * sessions. The fork sidecar replaces `incognitoDefaults` as a whole, so every write sends the full
 * resolved object with one capability flipped.
 *
 * The full-object write races with the settings refresh: two quick toggles would both compute from
 * the same rendered defaults and the second write would erase the first. The section therefore
 * keeps an immediately-updated optimistic draft as the single source for the next write and
 * serializes writes through a promise chain; the draft resyncs from the refreshed settings once
 * the queue is idle, and a failed write reverts the draft to the stored defaults.
 */
export function IncognitoSettingsSection({
  settings,
  onUpdate,
}: {
  settings: AppSettings | null | undefined;
  onUpdate: (patch: Partial<AppSettings>) => Promise<void> | void;
}) {
  const { intl } = useZCodeIntl();
  const settingsDefaults = useMemo(
    () => resolveIncognitoDefaults(settings?.incognitoDefaults),
    [settings?.incognitoDefaults],
  );
  const [draft, setDraft] = useState<IncognitoCapabilities>(settingsDefaults);
  const draftRef = useRef<IncognitoCapabilities>(settingsDefaults);
  const settingsDefaultsRef = useRef<IncognitoCapabilities>(settingsDefaults);
  const writesRef = useRef<Promise<void>>(Promise.resolve());
  const pendingWritesRef = useRef(0);

  useEffect(() => {
    settingsDefaultsRef.current = settingsDefaults;
    if (pendingWritesRef.current === 0) {
      // The write queue is idle, so the refreshed settings are the source of truth again; while
      // writes are pending, the optimistic draft must win or the switches would flicker back.
      draftRef.current = settingsDefaults;
      setDraft(settingsDefaults);
    }
  }, [settingsDefaults]);

  const toggle = useCallback(
    (capability: IncognitoCapabilityKey, included: boolean) => {
      const next = { ...draftRef.current, [capability]: included };
      draftRef.current = next;
      setDraft(next);
      pendingWritesRef.current += 1;
      writesRef.current = writesRef.current
        .then(() => onUpdate({ incognitoDefaults: next }))
        .catch((error) => {
          logger.warn("Incognito defaults write failed; reverting to the stored defaults", {
            error,
          });
          draftRef.current = settingsDefaultsRef.current;
          setDraft(settingsDefaultsRef.current);
        })
        .finally(() => {
          pendingWritesRef.current -= 1;
        });
    },
    [onUpdate],
  );

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
                  checked={draft[capability]}
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
