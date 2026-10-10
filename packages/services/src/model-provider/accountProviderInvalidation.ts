interface SettingUpdatedEvent {
  readonly keys: readonly string[];
}

interface AccountProviderInvalidationOptions {
  readonly onDidUpdateSetting: (listener: (event: SettingUpdatedEvent) => void) => () => void;
  readonly refresh: (reason: string) => Promise<unknown>;
}

const ACCOUNT_PROVIDER_SETTING_KEYS = new Set([
  "providerFamilyDomain",
  "providerFamilyConnectionSelections",
  "zcodeEndpointOrigin",
]);

/**
 * Consolidate Settings changes that affect account-connection selection into an AccountProviderService refresh.
 *
 * OAuth login/logout and purchase completion refresh the Account Source directly in their respective business flows. Do not
 * subscribe here to events from the retired Registry, which would reintroduce a parallel source of truth.
 */
export function bindAccountProviderInvalidation(
  options: AccountProviderInvalidationOptions,
): () => void {
  const requestRefresh = (reason: string): void => {
    void options.refresh(reason).catch(() => {
      // AccountProviderService records failures centrally through onDidRefreshError and preserves the last-known-good state.
    });
  };
  const disposeSetting = options.onDidUpdateSetting((event) => {
    const keys = event.keys.filter((key) => ACCOUNT_PROVIDER_SETTING_KEYS.has(key));
    if (keys.length > 0) {
      requestRefresh(`settings:${keys.join(",")}`);
    }
  });

  return () => {
    disposeSetting();
  };
}
