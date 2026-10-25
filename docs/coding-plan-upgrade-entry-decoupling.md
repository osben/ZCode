# Coding Plan upgrade entry decoupling

## Background

Previously every "升级 Coding Plan" (upgrade Coding Plan) entry navigated to the Model Provider settings page, which used upgrade fields on the Model Provider target to make `ModelProviderSection` select the provider and expand the purchase panel. That bound the purchase flow to the settings page's navigation state, so external upgrade entries depended on the provider family's selected key, connection fallbacks, and settings hydration timing.

## Goals

- The upgrade entry is carried by one UI-level dialog capability; it is not mounted as an external navigation intent on `SettingsPage`, `App`, the workspace shell, or `ModelProviderSection`.
- Entries no longer use `codingPlanUpgrade*` settings intents; entry components call `useCodingPlanUpgradeDialog().openCodingPlanUpgrade(target)` directly.
- The old Model Provider / Settings upgrade navigation fields stay removed (no compatibility layer); the upgrade action must be invoked directly by the actual entry.
- The Model Provider settings page keeps only provider configuration, connection-type switching, and the status card; Subscribe / Upgrade inside the status card is a local entry, not a host for external entries.
- External entries never open Settings; after the upgrade panel closes, the user stays in the current workspace.

## Interaction chain

```text
Sidebar / Chat quota / Input toolbar / Settings model provider status card
  -> useCodingPlanUpgradeDialog().openCodingPlanUpgrade({ providerId })
  -> CodingPlanUpgradeDialog
```

## Implementation constraints

- `SettingsPage` does not recognize `codingPlanUpgradeProviderId` / `codingPlanUpgradeReturnTarget` / `codingPlanUpgradeFunnelContext` as upgrade entries.
- `ModelProviderSection` accepts only plain `modelProviderId` targeting intent, never purchase intent.
- The standalone upgrade host resolves the OAuth provider, the product-source provider, the current plan state, and the purchase token state from the provider id.
- When Start Plan opens the upgrade, the product list must map to the same family's paid Coding Plan provider.
- After a purchase completes, refresh the provider list and entitlement state, so Settings / Usage no longer show the old plan once the panel closes.
- Workspace external entries must not switch to Settings to open the upgrade panel; they only call the dialog capability and stay in context after close.
- The settings status card's Subscribe / Upgrade calls the dialog capability directly; it holds no purchase-dialog state and passes no purchase-dialog props upward.

## Todo103 integration boundaries

- Keep the staging direction of deleting the native purchase panel and using the official-site WebView; native SKU selection, payment polling, and their dedicated telemetry are not restored as client features.
- Keep what is still used: product-source resolution, enterprise tier display, entry telemetry, and purchase-completion refresh. Start upgrade points to the same-domain specific Individual Provider; the old Coding Plan identity is not restored.
- The settings page uses ProviderSettingsView and the Personal write API; template creation, dynamic model editing/sorting, and manual switching for invalid connections do not regress from the purchase UI removal.
- A Team status card still specifies a team audience when upgrading; a normal status card defaults to personal. Team keys passed by existing specific team purchase entries stay. Deleting the native panel must not silently turn a Team upgrade into a personal purchase.
- Verify jointly by entry, purchase host, and completion refresh; tests specific to native components retire with that feature, tests still used by current entries stay.
- Full-connection plan statistics reuse the root Environment's ProviderSettingsView and the read-only plan query: no reads of the old `Provider.apiKey`, no current/executable requirement. Start and specific Individual are queried separately; Team uses the existing authenticated pricing. A first-read failure in Settings is not treated as an empty-list pass-through; a retry only loads data.
